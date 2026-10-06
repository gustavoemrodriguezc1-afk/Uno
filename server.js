const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
// No cachear HTML/CSS/JS: todos los dispositivos siempre reciben la versión nueva
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const COLORS = ['red', 'yellow', 'green', 'blue'];

// ---------- Mazo UNO (108 cartas) ----------
function buildDeck() {
  const deck = [];
  let id = 0;
  for (const c of COLORS) {
    deck.push({ id: id++, c, v: '0' });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, c, v: String(n) });
      deck.push({ id: id++, c, v: String(n) });
    }
    for (const v of ['skip', 'reverse', '+2']) {
      deck.push({ id: id++, c, v });
      deck.push({ id: id++, c, v });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, c: 'wild', v: 'wild' });
    deck.push({ id: id++, c: 'wild', v: 'wild4' });
  }
  // Barajar
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const rooms = new Map();

function makeRoom(code) {
  return {
    code,
    players: {},   // socketId -> { name, hand: [], saidUno }
    order: [],     // [socketId, socketId]
    deck: [],
    discard: [],
    color: null,   // color activo (si hay comodín)
    turn: 0,       // índice en order
    drawn: false,  // ya robó carta este turno
    state: 'waiting', // waiting | playing | ended
    winner: null,
  };
}

function topCard(room) { return room.discard[room.discard.length - 1]; }

function canPlay(room, card) {
  const top = topCard(room);
  if (card.c === 'wild') return true;
  if (card.c === room.color) return true;
  if (top.v === card.v) return true;
  return false;
}

function drawCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    if (room.deck.length === 0) {
      // Rebarajar el descarte (excepto la carta de arriba)
      const top = room.discard.pop();
      room.deck = room.discard;
      room.discard = [top];
      for (let k = room.deck.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [room.deck[k], room.deck[j]] = [room.deck[j], room.deck[k]];
      }
    }
    if (room.deck.length > 0) player.hand.push(room.deck.pop());
  }
}

function nextTurn(room, again = false) {
  // Con 2 jugadores: skip/reverse/+2/wild4 = el mismo jugador repite
  if (!again) room.turn = 1 - room.turn;
  room.drawn = false;
}

function sendState(room) {
  const pub = {
    top: topCard(room),
    color: room.color,
    counts: {},
    names: {},
    turnId: room.order[room.turn],
    drawn: room.drawn,
    winner: room.winner,
  };
  for (const id of room.order) {
    pub.counts[id] = room.players[id].hand.length;
    pub.names[id] = room.players[id].name;
  }
  io.to(room.code).emit('public', pub);
  for (const id of room.order) {
    io.to(id).emit('hand', room.players[id].hand);
  }
}

function startGame(room) {
  room.state = 'playing';
  room.winner = null;
  room.deck = buildDeck();
  for (const id of room.order) room.players[id].hand = [];
  // Repartir 7
  for (let i = 0; i < 7; i++) {
    for (const id of room.order) {
      room.players[id].hand.push(room.deck.pop());
    }
  }
  // Primera carta del descarte (sin comodines ni especiales)
  let first = room.deck.pop();
  while (first.c === 'wild' || isNaN(Number(first.v))) {
    room.deck.unshift(first);
    first = room.deck.pop();
  }
  room.discard = [first];
  room.color = first.c;
  room.turn = 0;
  room.drawn = false;
  io.to(room.code).emit('gameStart', { players: room.order.map(id => ({ id, name: room.players[id].name })) });
  sendState(room);
}

function checkWin(room, player, socketId) {
  if (player.hand.length === 0) {
    room.state = 'ended';
    room.winner = player.name;
    sendState(room);
    io.to(room.code).emit('gameOver', { winner: player.name, winnerId: socketId });
    return true;
  }
  return false;
}

function roomCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  let myRoom = null;

  socket.on('createRoom', ({ name }, cb) => {
    const code = roomCode();
    const room = makeRoom(code);
    room.players[socket.id] = { name: name || 'User', hand: [] };
    room.order = [socket.id];
    rooms.set(code, room);
    socket.join(code);
    myRoom = code;
    cb({ ok: true, code });
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.order.length >= 2) return cb({ ok: false, error: 'Room is full' });
    room.players[socket.id] = { name: name || 'User', hand: [] };
    room.order.push(socket.id);
    socket.join(code);
    myRoom = code;
    cb({ ok: true, code });
    io.to(code).emit('playerJoined', { name: room.players[socket.id].name });
    setTimeout(() => { if (rooms.get(code)?.state === 'waiting') startGame(room); }, 800);
  });

  socket.on('playCard', ({ cardId, chosenColor }, cb) => {
    const room = rooms.get(myRoom);
    if (!room || room.state !== 'playing') return cb?.({ ok: false });
    if (room.order[room.turn] !== socket.id) return cb?.({ ok: false, error: "It's not your turn" });
    const player = room.players[socket.id];
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return cb?.({ ok: false });
    const card = player.hand[idx];
    if (!canPlay(room, card)) return cb?.({ ok: false, error: 'You can\'t play that card' });

    player.hand.splice(idx, 1);
    room.discard.push(card);

    if (card.c === 'wild') {
      room.color = COLORS.includes(chosenColor) ? chosenColor : COLORS[Math.floor(Math.random() * 4)];
    } else {
      room.color = card.c;
    }

    const opponent = room.players[room.order[1 - room.turn]];
    let again = false;
    if (card.v === 'skip' || card.v === 'reverse') again = true;
    if (card.v === '+2') { drawCards(room, opponent, 2); again = true; }
    if (card.v === 'wild4') { drawCards(room, opponent, 4); again = true; }

    if (!checkWin(room, player, socket.id)) {
      nextTurn(room, again);
      sendState(room);
    }
    cb?.({ ok: true });
  });

  socket.on('drawCard', (cb) => {
    const room = rooms.get(myRoom);
    if (!room || room.state !== 'playing') return cb?.({ ok: false });
    if (room.order[room.turn] !== socket.id) return cb?.({ ok: false });
    if (room.drawn) return cb?.({ ok: false, error: 'You can only draw one card per turn' });
    const player = room.players[socket.id];
    drawCards(room, player, 1);
    room.drawn = true;
    sendState(room);
    cb?.({ ok: true });
  });

  socket.on('passTurn', (cb) => {
    const room = rooms.get(myRoom);
    if (!room || room.state !== 'playing') return cb?.({ ok: false });
    if (room.order[room.turn] !== socket.id) return cb?.({ ok: false });
    if (!room.drawn) return cb?.({ ok: false, error: 'Draw a card first' });
    nextTurn(room);
    sendState(room);
    cb?.({ ok: true });
  });

  socket.on('sayUno', () => {
    const room = rooms.get(myRoom);
    if (!room) return;
    const p = room.players[socket.id];
    if (p && p.hand.length === 1) {
      io.to(myRoom).emit('unoCalled', { name: p.name });
    }
  });

  socket.on('chat', (msg) => {
    const room = rooms.get(myRoom);
    if (!room || !room.players[socket.id]) return;
    msg = String(msg).slice(0, 140).trim();
    if (!msg) return;
    io.to(myRoom).emit('chat', { name: room.players[socket.id].name, msg });
  });

  socket.on('rematch', () => {
    const room = rooms.get(myRoom);
    if (!room || room.state !== 'ended') return;
    if (room.order.length === 2) startGame(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(myRoom);
    if (!room) return;
    const pname = room.players[socket.id]?.name || 'A player';
    delete room.players[socket.id];
    room.order = room.order.filter(id => id !== socket.id);
    room.state = 'waiting';
    if (room.order.length === 0) {
      rooms.delete(myRoom);
    } else {
      io.to(myRoom).emit('opponentLeft', { name: pname });
    }
  });
});

server.listen(PORT, () => console.log(`UNO corriendo en http://localhost:${PORT}`));
