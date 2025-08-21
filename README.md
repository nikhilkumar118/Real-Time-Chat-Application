# Realtime Chat (Extended)

A real-time chat app built with **Node.js**, **Express**, and **Socket.IO**, with:
- User registration & login (session-based)
- Room-based chat
- Typing indicators
- Join/leave notifications
- Message history (saved to `db.json` via lowdb)
- Dark, minimal UI

## Requirements
- Node.js 18+

## Quick start
```bash
npm install
npm run dev   # or: npm start
# Open http://localhost:3000
```

## Accounts
Create an account via the **Register** tab. Passwords are hashed with bcryptjs. Sessions are stored in-memory (development only).

## Project structure
```
realtime-chat-extended/
├── package.json
├── server.js
├── db.js
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    └── client.js
```

## Notes
- This demo uses file-based persistence (`lowdb`, `db.json` in project root).
- For production, use a real database and a persistent session store (e.g., Redis).

