import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import session from 'express-session'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { db, initDb } from './db.js'

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } })

await initDb()

// Middleware
app.use(express.json())
app.use(cookieParser())
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
})
app.use(sessionMiddleware)

// Share session with Socket.IO
io.engine.use(sessionMiddleware)

// Static files
app.use(express.static('public'))

// --------- Auth routes ---------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {}
  if (typeof username !== 'string' || typeof password !== 'string' ||
      username.trim().length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Invalid username or password' })
  }
  await db.read()
  const exists = db.data.users.find(u => u.username.toLowerCase() === username.trim().toLowerCase())
  if (exists) return res.status(409).json({ error: 'Username already taken' })

  const id = nanoid()
  const hash = await bcrypt.hash(password, 10)
  db.data.users.push({ id, username: username.trim(), passwordHash: hash, createdAt: Date.now() })
  await db.write()
  req.session.user = { id, username: username.trim() }
  res.json({ ok: true, user: req.session.user })
})

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {}
  await db.read()
  const user = db.data.users.find(u => u.username === String(username).trim())
  if (!user) return res.status(401).json({ error: 'Invalid credentials' })
  const ok = await bcrypt.compare(String(password), user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
  req.session.user = { id: user.id, username: user.username }
  res.json({ ok: true, user: req.session.user })
})

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null })
})

// --------- Socket.IO ---------
// Track rooms in memory for presence
const roomMembers = new Map() // Map<room, Set<socket.id>>

function joinRoom(socket, room) {
  if (!roomMembers.has(room)) roomMembers.set(room, new Set())
  roomMembers.get(room).add(socket.id)
  socket.join(room)
}
function leaveRoom(socket, room) {
  if (!room) return
  const set = roomMembers.get(room)
  if (set) {
    set.delete(socket.id)
    if (set.size === 0) roomMembers.delete(room)
  }
  socket.leave(room)
}
function getUserCount(room) {
  const set = roomMembers.get(room)
  return set ? set.size : 0
}

io.on('connection', (socket) => {
  const sess = socket.request.session
  if (!sess || !sess.user) {
    socket.emit('unauthorized')
    return socket.disconnect(true)
  }

  const user = sess.user // { id, username }
  let currentRoom = null

  socket.on('join', async ({ room }) => {
    const safeRoom = String(room || 'general').slice(0, 50)
    if (currentRoom === safeRoom) return

    // leave previous
    if (currentRoom) {
      leaveRoom(socket, currentRoom)
      io.to(currentRoom).emit('systemMessage', `${user.username} left the room.`)
      io.to(currentRoom).emit('presence', { room: currentRoom, count: getUserCount(currentRoom) })
    }

    currentRoom = safeRoom
    joinRoom(socket, currentRoom)

    // History (last 30 messages)
    await db.read()
    const history = db.data.messages
      .filter(m => m.room === currentRoom)
      .sort((a,b) => a.ts - b.ts)
      .slice(-30)
    socket.emit('history', history)

    socket.emit('systemMessage', `Welcome ${user.username}! You joined #${currentRoom}.`)
    socket.to(currentRoom).emit('systemMessage', `${user.username} joined the room.`)
    io.to(currentRoom).emit('presence', { room: currentRoom, count: getUserCount(currentRoom) })
  })

  socket.on('chatMessage', async (text) => {
    if (!currentRoom) return
    const msg = {
      id: nanoid(),
      username: user.username,
      room: currentRoom,
      text: String(text ?? '').slice(0, 2000),
      ts: Date.now()
    }
    await db.read()
    db.data.messages.push(msg)
    await db.write()
    io.to(currentRoom).emit('chatMessage', msg)
  })

  socket.on('typing', (isTyping) => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('typing', { username: user.username, isTyping: !!isTyping })
  })

  socket.on('switchRoom', (newRoom) => {
    if (typeof newRoom !== 'string') return
    socket.emit('join', { room: newRoom }) // let client re-emit join
  })

  socket.on('disconnect', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom)
      io.to(currentRoom).emit('systemMessage', `${user.username} left the room.`)
      io.to(currentRoom).emit('presence', { room: currentRoom, count: getUserCount(currentRoom) })
    }
  })
})

// Health
app.get('/health', (_req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`✅ http://localhost:${PORT}`))
