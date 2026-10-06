// WebSocket con respaldo automático a polling si la red bloquea WebSocket
const socket = io();

const $ = (id) => document.getElementById(id);
const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', wild: 'Wild' };

let myHand = [];
let pub = null;          // estado público del servidor
let myId = null;
let pendingWild = null;  // carta comodín esperando color
let connLost = false;    // este dispositivo perdió la conexión
let flashUntil = 0;

// ---------- Sesión (para reconectar a la misma sala) ----------
const SESSION_KEY = 'uno_session';
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

function getOppId() {
  return pub ? Object.keys(pub.names).find(id => id !== myId) : null;
}

function flash(text, ms = 2000) {
  flashUntil = Date.now() + ms;
  $('statusMsg').textContent = text;
  setTimeout(refreshStatus, ms);
}

function refreshStatus() {
  if (!pub || pub.winner) return;
  if (connLost) {
    $('statusMsg').textContent = '📡 Connection lost. Reconnecting...';
    return;
  }
  if (Date.now() < flashUntil) return;
  const oppId = getOppId();
  if (oppId && pub.connected && pub.connected[oppId] === false) {
    $('statusMsg').textContent = `⏳ ${pub.names[oppId]} lost connection. Waiting...`;
    return;
  }
  const isMyTurn = pub.turnId === myId;
  $('statusMsg').textContent = isMyTurn ? 'Your turn 👇' : `${pub.names[pub.turnId]}'s turn...`;
}

function showLobby(msg) {
  pub = null;
  myHand = [];
  myId = null;
  pendingWild = null;
  $('colorModal').classList.add('hidden');
  $('game').classList.add('hidden');
  $('waiting').classList.add('hidden');
  $('chatLog').innerHTML = '';
  $('lobby').classList.remove('hidden');
  $('lobbyError').textContent = msg || '';
}

// ---------- Conexión / reconexión ----------
socket.on('connect', () => {
  connLost = false;
  const s = loadSession();
  if (!s) return;
  socket.emit('rejoin', { token: s.token, code: s.code }, (res) => {
    if (!res || !res.ok) {
      clearSession();
      showLobby('Your last game is no longer available.');
      return;
    }
    myId = res.id;
    pendingWild = null;
    $('colorModal').classList.add('hidden');
    $('lobby').classList.add('hidden');
    if (res.started) {
      $('waiting').classList.add('hidden');
      $('game').classList.remove('hidden');
    } else {
      $('game').classList.add('hidden');
      $('waiting').classList.remove('hidden');
      $('showCode').textContent = res.code;
    }
    refreshStatus();
  });
});

socket.on('disconnect', () => {
  connLost = true;
  refreshStatus();
});

// ---------- Lobby ----------
$('btnCreate').onclick = () => {
  const name = $('nameInput').value.trim() || 'User';
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return $('lobbyError').textContent = res.error;
    myId = res.id;
    saveSession({ token: res.token, code: res.code });
    $('lobby').classList.add('hidden');
    $('waiting').classList.remove('hidden');
    $('showCode').textContent = res.code;
  });
};

$('btnJoin').onclick = () => {
  const name = $('nameInput').value.trim() || 'User';
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return $('lobbyError').textContent = 'Enter the code';
  socket.emit('joinRoom', { code, name }, (res) => {
    if (!res.ok) return $('lobbyError').textContent = res.error;
    myId = res.id;
    saveSession({ token: res.token, code: res.code });
    $('lobby').classList.add('hidden');
    $('waiting').classList.remove('hidden');
    $('showCode').textContent = res.code;
  });
};

// ---------- Eventos ----------
socket.on('playerJoined', ({ name }) => {
  $('waiting').classList.add('hidden');
  $('game').classList.remove('hidden');
});

socket.on('gameStart', () => {
  $('btnRematch').classList.add('hidden');
  flash('Dealing cards!', 1200);
});

socket.on('hand', (hand) => {
  myHand = hand;
  renderHand();
  updateUnoBtn();
});

socket.on('public', (p) => {
  pub = p;
  renderTable();
  const isMyTurn = p.turnId === myId && !p.winner;
  if (p.winner) {
    $('statusMsg').textContent = p.winnerId === myId ? '🏆 You won the game!' : `🏆 ${p.winner} won the game!`;
    $('btnRematch').classList.remove('hidden');
  } else {
    refreshStatus();
  }
  // Botón Pass: solo en tu turno, después de robar una carta
  $('btnPass').classList.toggle('hidden', !(isMyTurn && p.drawn));
  // Botón acusar: solo lo ve el rival del que no dijo UNO
  $('btnAccuse').classList.toggle('hidden',
    !(p.unoVulnerable && p.unoVulnerable !== myId && !p.winner));
  updateUnoBtn();
  renderHand();
});

socket.on('unoCalled', ({ name }) => {
  flash(`🔴 UNO! ${name} has one card left`);
});

socket.on('unoPenalty', ({ name }) => {
  flash(`⚠️ ${name} didn't say UNO! +2 cards`, 2500);
});

socket.on('gameOver', ({ winner, winnerId }) => {
  const iWon = winnerId === myId;
  $('statusMsg').textContent = iWon ? '🏆 You won the game!' : `🏆 ${winner} won the game!`;
  $('btnRematch').classList.remove('hidden');
});

socket.on('opponentLeft', ({ name }) => {
  clearSession();
  $('statusMsg').textContent = `${name} disconnected 😢`;
  $('btnRematch').classList.add('hidden');
  setTimeout(() => showLobby('The room closed. Create a new game.'), 2500);
});

socket.on('chat', ({ name, msg }) => {
  const log = $('chatLog');
  const div = document.createElement('div');
  div.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(msg)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
});

$('btnRematch').onclick = () => socket.emit('rematch');
$('deckPile').onclick = () => {
  if (!pub || pub.turnId !== myId || pub.drawn) return;
  socket.emit('drawCard');
};

$('btnPass').onclick = () => {
  if (!pub || pub.turnId !== myId || !pub.drawn) return;
  socket.emit('passTurn');
};

// Botones UNO
$('btnUno').onclick = () => socket.emit('sayUno');
$('btnAccuse').onclick = () => socket.emit('accuseUno');

// Chat
function sendChat() {
  const msg = $('chatInput').value.trim();
  if (!msg) return;
  socket.emit('chat', msg);
  $('chatInput').value = '';
}
$('btnChat').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Render ----------
function cardHtml(card) {
  const label = card.c === 'wild'
    ? (card.v === 'wild4' ? '+4' : '★')
    : (card.v === 'skip' ? '⊘' : card.v === 'reverse' ? '⇄' : card.v);
  return `<div class="ucard ${card.c}">
    <span class="corner tl">${label}</span>
    <span>${label}</span>
    <span class="corner br">${label}</span>
  </div>`;
}

function renderTable() {
  if (!pub) return;
  $('topCard').outerHTML = cardHtml(pub.top).replace('class="ucard', 'id="topCard" class="ucard');
  $('colorLabel').textContent = COLOR_NAMES[pub.color] || '-';
  $('colorLabel').style.color = pub.color === 'yellow' ? '#f1c40f' : pub.color;

  const oppId = getOppId();
  if (oppId) {
    const away = pub.connected && pub.connected[oppId] === false;
    $('oppName').textContent = pub.names[oppId] + (away ? ' ⏳' : '');
    $('oppCount').textContent = `🃏 x${pub.counts[oppId]}`;
  }
}

function isPlayable(card) {
  if (!pub) return false;
  if (pub.turnId !== myId || pub.winner) return false;
  if (card.c === 'wild') return true;
  if (card.c === pub.color) return true;
  if (pub.top.v === card.v) return true;
  return false;
}

function renderHand() {
  const container = $('myHand');
  container.innerHTML = '';
  if (!pub) return;
  const isMyTurn = pub.turnId === myId && !pub.winner;
  // Ordenar por color y valor para que se vea bonito
  const sorted = [...myHand].sort((a, b) =>
    (a.c + a.v).localeCompare(b.c + b.v, undefined, { numeric: true }));
  for (const card of sorted) {
    const div = document.createElement('div');
    div.innerHTML = cardHtml(card);
    const el = div.firstChild;
    const playable = isPlayable(card);
    if (playable) el.classList.add('playable');
    el.onclick = () => {
      if (!isMyTurn) return;
      if (!playable) return;
      if (card.c === 'wild') {
        pendingWild = card;
        $('colorModal').classList.remove('hidden');
      } else {
        socket.emit('playCard', { cardId: card.id });
      }
    };
    container.appendChild(el);
  }
}

function updateUnoBtn() {
  const show = myHand.length === 1 && pub && pub.unoVulnerable === myId;
  $('btnUno').classList.toggle('hidden', !show);
}

// Selector de color
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.onclick = () => {
    $('colorModal').classList.add('hidden');
    if (pendingWild) {
      socket.emit('playCard', { cardId: pendingWild.id, chosenColor: btn.dataset.color });
      pendingWild = null;
    }
  };
});
