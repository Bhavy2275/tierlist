const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50e6,
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '1.html')));

function getNetworkIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push({ name, address: iface.address });
    }
  }
  return ips;
}

app.get('/api/network-info', (req, res) => {
  const ips = getNetworkIps();
  const primaryIp = ips[0]?.address || 'localhost';
  const port = process.env.PORT || 3000;
  res.json({ primaryIp, allIps: ips, port, inviteBaseUrl: `http://${primaryIp}:${port}` });
});

app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('Missing text');
  try {
    const buf = await QRCode.toBuffer(text, { width: 250, margin: 2, color: { dark: '#0f172a', light: '#fff' } });
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch { res.status(500).send('QR error'); }
});

// rooms[code] = { host, users:[{id,name}], state:{tiers,pool}, voting:null|{...} }
const rooms = {};
const TIER_NAMES = ['S', 'A', 'B', 'C', 'D'];
const TIER_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4'];

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function userList(room) {
  return room.users.map(u => ({ id: u.id, name: u.name, isHost: u.id === room.host }));
}

function avgToTier(avg) {
  if (avg >= 9) return 'S';
  if (avg >= 7) return 'A';
  if (avg >= 5) return 'B';
  if (avg >= 3) return 'C';
  return 'D';
}

function makeDefaultState() {
  return {
    tiers: TIER_NAMES.map((label, i) => ({ label, bg: TIER_COLORS[i], textColor: '#ffffff', images: [] })),
    pool: []
  };
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Create Room ────────────────────────────────────────────────────────────
  socket.on('createRoom', ({ name, state }, cb) => {
    let code = genCode();
    while (rooms[code]) code = genCode();

    rooms[code] = {
      host: socket.id,
      users: [{ id: socket.id, name: name || 'Host' }],
      state: makeDefaultState(),
      voting: null
    };

    socket.join(code);
    socket.roomCode = code;
    socket.userName = name || 'Host';

    cb({ success: true, code, isHost: true, users: userList(rooms[code]) });
    io.to(code).emit('roomUsers', userList(rooms[code]));
    console.log(`[ROOM] Created ${code} by ${name}`);
  });

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ success: false, error: 'Room not found. Check the code and try again.' });

    if (!room.users.find(u => u.id === socket.id)) {
      room.users.push({ id: socket.id, name: name || 'Guest' });
    }

    socket.join(code);
    socket.roomCode = code;
    socket.userName = name || 'Guest';

    socket.to(code).emit('userJoined', { id: socket.id, name: socket.userName });
    io.to(code).emit('roomUsers', userList(room));

    const v = room.voting;
    cb({
      success: true, code,
      isHost: (socket.id === room.host),
      users: userList(room),
      state: room.state,
      // If a vote is currently active, give the joiner enough to join it
      voting: v && v.active ? {
        imageSrc: v.imageSrc,
        comment: v.comment,
        voted: Object.keys(v.ratings).length,
        total: v.voterIds.length
      } : null
    });
    console.log(`[ROOM] ${name} joined ${code}`);
  });

  // ── Sync State ────────────────────────────────────────────────────────────
  socket.on('syncState', ({ state }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    rooms[code].state = state;
    socket.to(code).emit('stateSync', { state });
  });

  // ── Present Image (host only) ─────────────────────────────────────────────
  socket.on('presentImage', ({ src, comment }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;

    const voterIds = rooms[code].users.map(u => u.id);
    rooms[code].voting = { imageSrc: src, comment: comment || '', ratings: {}, active: true, voterIds };

    io.to(code).emit('imagePresented', { src, comment: comment || '', voted: 0, total: voterIds.length });
    console.log(`[VOTE] Image presented in ${code} to ${voterIds.length} voters`);
  });

  // ── Host updates comment live ─────────────────────────────────────────────
  socket.on('updateComment', ({ comment }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;
    if (rooms[code].voting) rooms[code].voting.comment = comment;
    socket.to(code).emit('commentUpdated', { comment });
  });

  // ── Submit Rating ─────────────────────────────────────────────────────────
  socket.on('submitRating', ({ rating }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const v = rooms[code].voting;
    if (!v || !v.active) return;

    v.ratings[socket.id] = Number(rating);

    const votedCount = Object.keys(v.ratings).length;
    const totalVoters = v.voterIds.length;
    io.to(code).emit('votingProgress', { voted: votedCount, total: totalVoters });

    const allVoted = v.voterIds.every(id => v.ratings[id] !== undefined);
    if (allVoted) finishVoting(code);
  });

  // ── Force Complete (host skips waiting for laggards) ─────────────────────
  socket.on('forceComplete', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;
    finishVoting(code);
  });

  function finishVoting(code) {
    const room = rooms[code];
    if (!room?.voting?.active) return;
    const v = room.voting;
    v.active = false;

    const scores = v.voterIds.filter(id => v.ratings[id] !== undefined).map(id => v.ratings[id]);
    if (!scores.length) return;

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const avgR = Math.round(avg * 10) / 10;
    const tier = avgToTier(avg);
    const tierIndex = TIER_NAMES.indexOf(tier);

    // Named ratings
    const namedRatings = {};
    for (const [sid, score] of Object.entries(v.ratings)) {
      const u = room.users.find(u => u.id === sid);
      namedRatings[u ? u.name : 'Unknown'] = score;
    }

    const result = { src: v.imageSrc, avg: avgR, tier, ratings: namedRatings, comment: v.comment };

    // Update stored state: add to tier, remove from pool
    if (room.state?.tiers?.[tierIndex]) {
      room.state.tiers[tierIndex].images.push({ src: v.imageSrc });
    }
    if (room.state?.pool) {
      room.state.pool = room.state.pool.filter(img => img.src !== v.imageSrc);
    }

    io.to(code).emit('votingComplete', result);
    // Broadcast updated tier state so everyone's list is in sync
    io.to(code).emit('stateSync', { state: room.state });
    console.log(`[VOTE] Done in ${code}: avg=${avgR} → Tier ${tier}`);
  }

  // ── Next Image (host dismisses result screen) ──────────────────────────────
  socket.on('nextImage', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;
    io.to(code).emit('waitingForNext');
  });

  // ── Leave / Disconnect ──────────────────────────────────────────────────────
  socket.on('leaveRoom', () => leave(socket));
  socket.on('disconnect', () => { leave(socket); console.log(`[-] ${socket.id}`); });

  function leave(s) {
    const code = s.roomCode;
    if (!code || !rooms[code]) return;
    rooms[code].users = rooms[code].users.filter(u => u.id !== s.id);
    s.leave(code);
    s.roomCode = null;

    if (rooms[code].users.length === 0) {
      delete rooms[code];
      console.log(`[ROOM] Deleted ${code}`);
    } else {
      if (rooms[code].host === s.id) {
        rooms[code].host = rooms[code].users[0].id;
        io.to(rooms[code].host).emit('youAreHost');
      }
      io.to(code).emit('userLeft', { id: s.id, name: s.userName });
      io.to(code).emit('roomUsers', userList(rooms[code]));

      // If voter left during active vote, re-check completion
      const v = rooms[code].voting;
      if (v?.active) {
        v.voterIds = v.voterIds.filter(id => id !== s.id);
        if (v.voterIds.length > 0 && v.voterIds.every(id => v.ratings[id] !== undefined)) {
          finishVoting(code);
        }
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ips = getNetworkIps();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`🚀 TierMaker Server running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  ips.forEach(i => console.log(`   Network (${i.name}): http://${i.address}:${PORT}`));
  if (ips.length) console.log(`\n   📱 Share the Network URL for other devices.`);
  console.log(`${'='.repeat(52)}\n`);
});
