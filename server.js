const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50e6 // 50MB - needed for base64 images
});

// Serve static files (the HTML)
app.use(express.static(__dirname));

// Redirect root to 1.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '1.html'));
});

// Room storage: { roomCode: { host, users: [{id, name}], state: null } }
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getUserList(room) {
  return room.users.map(u => ({ id: u.id, name: u.name }));
}

io.on('connection', (socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  // ─── Create Room ───────────────────────────────────────────────────────────
  socket.on('createRoom', ({ name, state }, callback) => {
    let code = generateRoomCode();
    while (rooms[code]) code = generateRoomCode(); // ensure unique

    rooms[code] = {
      host: socket.id,
      users: [{ id: socket.id, name: name || 'Host' }],
      state: state || null
    };

    socket.join(code);
    socket.roomCode = code;
    socket.userName = name || 'Host';

    console.log(`[ROOM] Created: ${code} by ${name}`);
    callback({ success: true, code, users: getUserList(rooms[code]) });

    // Announce to room (just the host right now)
    io.to(code).emit('roomUsers', getUserList(rooms[code]));
  });

  // ─── Join Room ─────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ code, name }, callback) => {
    code = code.toUpperCase().trim();
    const room = rooms[code];

    if (!room) {
      return callback({ success: false, error: 'Room not found. Check the code and try again.' });
    }

    // Check if already in room
    const alreadyIn = room.users.find(u => u.id === socket.id);
    if (!alreadyIn) {
      room.users.push({ id: socket.id, name: name || 'Guest' });
    }

    socket.join(code);
    socket.roomCode = code;
    socket.userName = name || 'Guest';

    console.log(`[ROOM] ${name} joined: ${code}`);

    // Notify everyone else
    socket.to(code).emit('userJoined', { id: socket.id, name: name || 'Guest' });
    io.to(code).emit('roomUsers', getUserList(room));

    callback({
      success: true,
      code,
      users: getUserList(room),
      state: room.state // Send current state so new joiner can sync
    });
  });

  // ─── Full State Sync (broadcast to room) ──────────────────────────────────
  socket.on('syncState', ({ state }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    // Update stored state
    rooms[code].state = state;

    // Broadcast to everyone else in the room
    socket.to(code).emit('stateSync', { state, from: socket.userName });
  });

  // ─── Leave Room ────────────────────────────────────────────────────────────
  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log(`[-] User disconnected: ${socket.id}`);
  });

  function handleLeave(socket) {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    // Remove from user list
    rooms[code].users = rooms[code].users.filter(u => u.id !== socket.id);

    socket.leave(code);
    socket.roomCode = null;

    if (rooms[code].users.length === 0) {
      // Empty room — delete it
      delete rooms[code];
      console.log(`[ROOM] Deleted (empty): ${code}`);
    } else {
      // Reassign host if needed
      if (rooms[code].host === socket.id) {
        rooms[code].host = rooms[code].users[0].id;
        io.to(rooms[code].host).emit('youAreHost');
      }
      io.to(code).emit('userLeft', { id: socket.id, name: socket.userName });
      io.to(code).emit('roomUsers', getUserList(rooms[code]));
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Tier List Server running at http://localhost:${PORT}`);
  console.log(`   Share this URL on your local network to invite others.\n`);
});
