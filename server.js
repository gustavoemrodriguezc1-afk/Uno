const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Tiempo que la sala espera a que alguien vuelva antes de cerrarse
const GRACE_PLAYING_MS = 60 * 1000;      // partida en curso
const GRACE_WAITING_MS = 3 * 60 * 1000;  // creador esperando rival

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
    players: {},   // token -> jugador
    order: [],     // [token, token]
    deck: [],
    discard: [],
    color: null,   // color activo (si hay comodín)
    turn: 0,       // índice en order
    drawn: false,  // ya robó carta este turno
    state: 'waiting', // waiting | playing | ended
    winner: null,
    winnerId: null,
    unoVulnerable: null, // token del jugador con 1 carta que no dijo UNO
  };
}

// token = secreto para reconectar (nunca se comparte con el rival)
// id    = identificador público que ve el otro jugador
function newPlayer(name, sid) {
  return {
    token: crypto.randomBytes(16).toString('hex'),
    id: crypto.randomBytes(4).toString('hex'),
    sid,                 // socket actual
    name: String(name || 'User').slice(0, 14),
    hand: [],
    saidUno: false,
    connected: true,
    timer: null,         // temporizador de gracia al desconectarse
  };
}

function emitTo(player, event, data) {
  if (player && player.connected && player.sid) io.to(player.sid).emit(event, data);
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
  const vulnerable = room.unoVulnerable ? room.players[room.unoVulnerable] : null;
  const pub = {
    top: topCard(room),
    color: room.color,
    counts: {},
    names: {},
    connected: {},
    turnId: room.players[room.order[room.turn]].id,
    drawn: room.drawn,
    winner: room.winner,
    winnerId: room.winnerId,
    unoVulnerable: vulnerable ? vulnerable.id : null,
  };
  for (const t of room.order) {
    const p = room.players[t];
    pub.counts[p.id] = p.hand.length;
    pub.names[p.id] = p.name;
    pub.connected[p.id] = p.connected;
  }
  io.to(room.code).emit('public', pub);
  for (const t of room.order) {
    emitTo(room.players[t], 'hand', room.players[t].hand);
  }
}

function startGame(room) {
  room.state = 'playing';
  room.winner = null;
  room.winnerId = null;
  room.deck = buildDeck();
  for (const t of room.order) room.players[t].hand = [];
  // Repartir 7
  for (let i = 0; i < 7; i++) {
    for (const t of room.order) {
      room.players[t].hand.push(room.deck.pop());
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
  room.unoVulnerable = null;
  for (const t of room.order) room.players[t].saidUno = false;
  io.to(room.code).emit('gameStart', {
    players: room.order.map(t => ({ id: room.players[t].id, name: room.players[t].name }))
  });
  sendState(room);
}

function checkWin(room, player) {
  if (player.hand.length === 0) {
    room.state = 'ended';
    room.winner = player.name;
    room.winnerId = player.id;
    sendState(room);
    io.to(room.code).emit('gameOver', { winner: player.name, winnerId: player.id });
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

// Cierra la sala por completo y avisa a quien quede
function closeRoom(room, leaver) {
  for (const t of room.order) {
    const p = room.players[t];
    if (p && p.timer) { clearTimeout(p.timer); p.timer = null; }
  }
  rooms.delete(room.code);
  if (leaver) io.to(room.code).emit('opponentLeft', { name: leaver.name });
  io.in(room.code).socketsLeave(room.code);
}

io.on('connection', (socket) => {
  let myRoom = null;   // código de la sala
  let myToken = null;  // token del jugador

  const ctx = () => {
    const room = myRoom ? rooms.get(myRoom) : null;
    const player = room ? room.players[myToken] : null;
    return { room, player };
  };

  // Si este socket ya estaba en una sala y empieza otra, cierra la anterior
  function leaveCurrentRoom() {
    const { room, player } = ctx();
    if (!room || !player) return;
    socket.leave(room.code);
    closeRoom(room, player);
    myRoom = null;
    myToken = null;
  }

  socket.on('createRoom', ({ name }, cb) => {
    leaveCurrentRoom();
    const code = roomCode();
    const room = makeRoom(code);
    const player = newPlayer(name, socket.id);
    room.players[player.token] = player;
    room.order = [player.token];
    rooms.set(code, room);
    socket.join(code);
    myRoom = code;
    myToken = player.token;
    cb?.({ ok: true, code, token: player.token, id: player.id });
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    leaveCurrentRoom();
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    if (room.order.length >= 2) return cb?.({ ok: false, error: 'Room is full' });
    const player = newPlayer(name, socket.id);
    room.players[player.token] = player;
    room.order.push(player.token);
    socket.join(code);
    myRoom = code;
    myToken = player.token;
    cb?.({ ok: true, code, token: player.token, id: player.id });
    io.to(code).emit('playerJoined', { name: player.name });
    setTimeout(() => {
      const r = rooms.get(code);
      if (r && r.state === 'waiting' && r.order.length === 2) startGame(r);
    }, 800);
  });

  // Volver a la sala después de una caída o de recargar la página
  socket.on('rejoin', ({ token, code }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    const player = room && room.players[token];
    if (!player) return cb?.({ ok: false });

    // Si había un socket viejo de este jugador, lo soltamos
    if (player.sid && player.sid !== socket.id) {
      io.sockets.sockets.get(player.sid)?.disconnect(true);
    }
    if (player.timer) { clearTimeout(player.timer); player.timer = null; }
    player.sid = socket.id;
    player.connected = true;
    socket.join(room.code);
    myRoom = room.code;
    myToken = token;

    cb?.({ ok: true, code: room.code, id: player.id, started: room.order.length === 2 });
    if (room.state !== 'waiting') sendState(room); // manda estado y mano a todos
  });

  socket.on('playCard', ({ cardId, chosenColor }, cb) => {
    const { room, player } = ctx();
    if (!room || !player || room.state !== 'playing') return cb?.({ ok: false });
    if (room.order[room.turn] !== myToken) return cb?.({ ok: false, error: "It's not your turn" });
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return cb?.({ ok: false });
    const card = player.hand[idx];
    if (!canPlay(room, card)) return cb?.({ ok: false, error: 'You can\'t play that card' });

    // UNO: si el rival ya jugó, se cierra la ventana para acusar
    if (room.unoVulnerable && room.unoVulnerable !== myToken) room.unoVulnerable = null;
    player.saidUno = false;

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

    if (!checkWin(room, player)) {
      room.unoVulnerable = player.hand.length === 1 ? myToken : null;
      nextTurn(room, again);
      sendState(room);
    }
    cb?.({ ok: true });
  });

  socket.on('drawCard', (cb) => {
    const { room, player } = ctx();
    if (!room || !player || room.state !== 'playing') return cb?.({ ok: false });
    if (room.order[room.turn] !== myToken) return cb?.({ ok: false });
    if (room.drawn) return cb?.({ ok: false, error: 'You can only draw one card per turn' });
    room.unoVulnerable = null;
    drawCards(room, player, 1);
    room.drawn = true;
    sendState(room);
    cb?.({ ok: true });
  });

  socket.on('passTurn', (cb) => {
    const { room, player } = ctx();
    if (!room || !player || room.state !== 'playing') return cb?.({ ok: false });
    if (room.order[room.turn] !== myToken) return cb?.({ ok: false });
    if (!room.drawn) return cb?.({ ok: false, error: 'Draw a card first' });
    nextTurn(room);
    sendState(room);
    cb?.({ ok: true });
  });

  socket.on('sayUno', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    if (player.hand.length === 1) {
      player.saidUno = true;
      if (room.unoVulnerable === myToken) room.unoVulnerable = null;
      io.to(room.code).emit('unoCalled', { name: player.name });
      sendState(room);
    }
  });

  socket.on('accuseUno', (cb) => {
    const { room, player } = ctx();
    if (!room || !player || room.state !== 'playing') return cb?.({ ok: false });
    const targetToken = room.unoVulnerable;
    if (!targetToken || targetToken === myToken) return cb?.({ ok: false });
    const target = room.players[targetToken];
    room.unoVulnerable = null;
    if (!target || target.hand.length !== 1 || target.saidUno) return cb?.({ ok: false });
    drawCards(room, target, 2);
    io.to(room.code).emit('unoPenalty', { name: target.name });
    sendState(room);
    cb?.({ ok: true });
  });

  socket.on('chat', (msg) => {
    const { room, player } = ctx();
    if (!room || !player) return;
    msg = String(msg).slice(0, 140).trim();
    if (!msg) return;
    io.to(room.code).emit('chat', { name: player.name, msg });
  });

  socket.on('rematch', () => {
    const { room } = ctx();
    if (!room || room.state !== 'ended') return;
    if (room.order.length === 2) startGame(room);
  });

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || !player) return;
    // Si el jugador ya volvió con otro socket, ignoramos este
    if (player.sid !== socket.id) return;

    player.connected = false;
    player.sid = null;
    if (room.state !== 'waiting') sendState(room); // el rival ve que se cayó

    const graceMs = room.state === 'waiting' ? GRACE_WAITING_MS : GRACE_PLAYING_MS;
    if (player.timer) clearTimeout(player.timer);
    player.timer = setTimeout(() => {
      const r = rooms.get(room.code);
      if (r && r.players[player.token] && !player.connected) closeRoom(r, player);
    }, graceMs);
  });
});

server.listen(PORT, () => console.log(`UNO corriendo en http://localhost:${PORT}`));
