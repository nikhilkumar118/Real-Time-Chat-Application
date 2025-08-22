import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import session from 'express-session'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { db, initDb } from './db.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } })

// --- GLOBAL STATE ---
const waitingQueue = new Set()         // Omegle queue: Set<socket.id>
const roomMembers = new Map()          // Map<room, Set<socket.id>>

await initDb()

// --- Middleware ---
app.use(express.json())
app.use(cookieParser())
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
})
app.use(sessionMiddleware)
io.engine.use(sessionMiddleware)

// --- Serve landing page at root ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'))
})

// --- Serve login page ---
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

// --- Serve chat application at /chat ---
app.get('/chat', (req, res) => {
  // Check if user is authenticated
  if (!req.session.user) {
    return res.redirect('/login')
  }
  res.sendFile(path.join(__dirname, 'public', 'chat.html'))
})

// --- Static files ---
app.use(express.static('public'))

// ==================== AUTH ROUTES ====================
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

// ==================== HELPERS ====================
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

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  const sess = socket.request.session
  if (!sess || !sess.user) {
    socket.emit('unauthorized')
    return socket.disconnect(true)
  }

  const user = sess.user // { id, username }
  let currentRoom = null

  // --- Normal Room Chat ---
  socket.on('join', async ({ room }) => {
    const safeRoom = String(room || 'general').slice(0, 50)
    if (currentRoom === safeRoom) return

    if (currentRoom) {
      leaveRoom(socket, currentRoom)
      io.to(currentRoom).emit('systemMessage', `${user.username} left the room.`)
      io.to(currentRoom).emit('presence', { room: currentRoom, count: getUserCount(currentRoom) })
    }

    currentRoom = safeRoom
    joinRoom(socket, currentRoom)

    await db.read()
    const history = db.data.messages
      .filter(m => m.room === currentRoom)
      .sort((a, b) => a.ts - b.ts)
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

  // --- Omegle Random Chat ---
  // helper to fully tear down a stranger chat and notify both sides correctly
  function handleStrangerLeave(leaverSocket) {
    const room = leaverSocket.data?.strangerRoom
    const partnerId = leaverSocket.data?.partnerId
    if (!room) return

    // tell the leaver "you disconnected"
    leaverSocket.emit('youDisconnected')

    // notify partner if still around
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId)
      if (partner) {
        partner.emit('strangerLeft')
        partner.leave(room)
        partner.data.strangerRoom = null
        partner.data.partnerId = null
      }
    }

    // cleanup leaver
    leaverSocket.leave(room)
    leaverSocket.data.strangerRoom = null
    leaverSocket.data.partnerId = null
  }

  socket.on('findStranger', () => {
    // if already in a stranger chat, leave it first
    if (socket.data?.strangerRoom) {
      handleStrangerLeave(socket)
    }

    if (waitingQueue.size > 0) {
      // pair with the first waiting user
      const [partnerId] = waitingQueue
      waitingQueue.delete(partnerId)

      const partnerSocket = io.sockets.sockets.get(partnerId)
      if (!partnerSocket || !partnerSocket.connected) {
        // partner vanished; just try again (put self in queue)
        waitingQueue.add(socket.id)
        socket.emit('waitingStranger')
        return
      }

      const strangerRoom = `stranger-${nanoid()}`
      partnerSocket.join(strangerRoom)
      socket.join(strangerRoom)

      partnerSocket.data.strangerRoom = strangerRoom
      partnerSocket.data.partnerId = socket.id
      socket.data.strangerRoom = strangerRoom
      socket.data.partnerId = partnerId

      io.to(strangerRoom).emit('strangerFound')
    } else {
      waitingQueue.add(socket.id)
      socket.emit('waitingStranger')
    }
  })

  socket.on('strangerMessage', (text) => {
    const room = socket.data?.strangerRoom
    const partnerId = socket.data?.partnerId
    if (!room || !partnerId) return

    const partner = io.sockets.sockets.get(partnerId)
    if (!partner || !partner.connected) {
      // partner gone; block sending and inform sender
      socket.emit('systemMessage', '❌ Your partner has disconnected.')
      return
    }

    io.to(room).emit('strangerMessage', {
      id: nanoid(),
      username: user.username,
      text: String(text ?? '').slice(0, 2000),
      ts: Date.now()
    })
  })

  socket.on('leaveStranger', () => {
    if (waitingQueue.has(socket.id)) {
      waitingQueue.delete(socket.id)
      socket.emit('youDisconnected')
      return
    }
    if (socket.data?.strangerRoom) {
      handleStrangerLeave(socket)
    }
  })

  // --- Disconnect cleanup ---
  socket.on('disconnect', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom)
      io.to(currentRoom).emit('systemMessage', `${user.username} left the room.`)
      io.to(currentRoom).emit('presence', { room: currentRoom, count: getUserCount(currentRoom) })
    }
    if (waitingQueue.has(socket.id)) {
      waitingQueue.delete(socket.id)
    }
    if (socket.data?.strangerRoom) {
      handleStrangerLeave(socket)
    }
  })
})

// --- Healthcheck ---
app.get('/health', (_req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`))