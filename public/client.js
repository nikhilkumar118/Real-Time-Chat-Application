let socket = null

// Elements
const tabs = document.querySelectorAll('.tab')
const loginForm = document.getElementById('loginForm')
const registerForm = document.getElementById('registerForm')
const loginUser = document.getElementById('loginUser')
const loginPass = document.getElementById('loginPass')
const regUser = document.getElementById('regUser')
const regPass = document.getElementById('regPass')

const presenceCard = document.getElementById('presence')
const meNameEl = document.getElementById('meName')
const roomNameEl = document.getElementById('roomName')
const roomCountEl = document.getElementById('roomCount')
const switchBtn = document.getElementById('switchBtn')
const logoutBtn = document.getElementById('logoutBtn')

const joinbar = document.getElementById('joinbar')
const joinForm = document.getElementById('joinForm')
const roomInput = document.getElementById('room')

const messagesEl = document.getElementById('messages')
const msgForm = document.getElementById('msgForm')
const msgInput = document.getElementById('msgInput')
const typingEl = document.getElementById('typing')

let myUsername = null
let myRoom = null
let typingTimeout = null

// Tabs
tabs.forEach(btn => btn.addEventListener('click', () => {
  tabs.forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  const tab = btn.dataset.tab
  if (tab === 'login') {
    loginForm.classList.remove('hidden')
    registerForm.classList.add('hidden')
  } else {
    loginForm.classList.add('hidden')
    registerForm.classList.remove('hidden')
  }
}))

// Helpers
function setLoggedIn(username) {
  myUsername = username
  meNameEl.textContent = username
  presenceCard.classList.remove('hidden')
  joinbar.classList.remove('hidden')
  // connect socket
  connectSocket()
}
function setLoggedOut() {
  myUsername = null
  presenceCard.classList.add('hidden')
  joinbar.classList.add('hidden')
  msgForm.classList.add('hidden')
  messagesEl.innerHTML = ''
  typingEl.textContent = ''
  if (socket) { socket.disconnect(); socket = null }
}

// API calls
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  return res.json()
}

// Auth flows
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = await api('/api/login', { username: loginUser.value, password: loginPass.value })
  if (data && data.user) {
    setLoggedIn(data.user.username)
  } else {
    alert(data.error || 'Login failed')
  }
})

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = await api('/api/register', { username: regUser.value, password: regPass.value })
  if (data && data.user) {
    setLoggedIn(data.user.username)
  } else {
    alert(data.error || 'Registration failed')
  }
})

logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', {})
  setLoggedOut()
})

// Join room
joinForm.addEventListener('submit', (e) => {
  e.preventDefault()
  myRoom = roomInput.value.trim() || 'general'
  roomNameEl.textContent = myRoom
  messagesEl.innerHTML = ''
  msgForm.classList.remove('hidden')
  socket.emit('join', { room: myRoom })
})

// Send message


msgForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = msgInput.value.trim()
  if (!text) return
  socket.emit('chatMessage', text)   // just emit
  msgInput.value = ''
  msgInput.focus()
  socket.emit('typing', false)
})


// Typing indicator
msgInput.addEventListener('input', () => {
  if (!socket) return
  socket.emit('typing', true)
  clearTimeout(typingTimeout)
  typingTimeout = setTimeout(() => socket.emit('typing', false), 900)
})

// Switch room
switchBtn.addEventListener('click', () => {
  const newRoom = prompt('Enter new room name:')
  if (!newRoom || newRoom === myRoom) return
  myRoom = newRoom
  roomNameEl.textContent = myRoom
  messagesEl.innerHTML = ''
  socket.emit('join', { room: myRoom })
})

// Socket connection
function connectSocket() {
  if (socket) socket.disconnect()
  socket = io({ withCredentials: true })
  socket.on('connect', () => { /* connected */ })
  socket.on('unauthorized', () => alert('Please login again.'))
  socket.on('systemMessage', (text) => addSystem(text))
  socket.on('chatMessage', (msg) => addMessage(msg, msg.username === myUsername))
  socket.on('typing', ({ username, isTyping }) => typingEl.textContent = isTyping ? `${username} is typing…` : '')
  socket.on('presence', ({ room, count }) => {
    if (room === myRoom) roomCountEl.textContent = String(count)
  })
  socket.on('history', (items) => {
    items.forEach(m => addMessage(m, m.username === myUsername))
    scrollBottom()
  })
}

// UI helpers
function addSystem(text) {
  const li = document.createElement('li')
  li.className = 'system'
  li.textContent = text
  messagesEl.appendChild(li)
  scrollBottom()
}
function addMessage({ username, text, ts }, isMe = false) {
  const li = document.createElement('li')
  li.className = `msg ${isMe ? 'me' : ''}`
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = `${username} • ${formatTime(ts)}`
  const body = document.createElement('div')
  body.textContent = text
  li.appendChild(meta)
  li.appendChild(body)
  messagesEl.appendChild(li)
  scrollBottom()
}
function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight }

// Auto-check session on load
;(async () => {
  try {
    const res = await fetch('/api/me')
    const data = await res.json()
    if (data && data.user) setLoggedIn(data.user.username)
  } catch {}
})()
