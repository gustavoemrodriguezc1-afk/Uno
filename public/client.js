const socket = io({ transports: ['websocket'] });

const $ = (id) => document.getElementById(id);
const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', wild: 'Wild' };

let myHand = [];
let pub = null;          // estado público del servidor
let myId = null;
let pendingWild = null;  // carta comodín esperando color

// ---------- Lobby ----------
$('btnCreate').onclick = () => {
  const name = $('nameInput').value.trim() || 'User';
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return $('lobbyError').textContent = res.error;
    myId = socket.id;
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
    myId = socket.id;
    $('lobby').classList.add('hidden');
    $('waiting').classList.remove('hidden');
    $('showCode').textContent = code;
  });
};

// ---------- Eventos ----------
socket.on('playerJoined', ({ name }) => {
  $('waiting').classList.add('hidden');
  $('game').classList.remove('hidden');
});

socket.on('gameStart', () => {
  $('btnRematch').classList.add('hidden');
  $('statusMsg').textContent = 'Dealing cards!';
  setTimeout(() => $('statusMsg').textContent = '', 1200);
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
  $('statusMsg').textContent = p.winner
    ? ''
    : isMyTurn ? 'Your turn 👇' : `${p.names[p.turnId]}'s turn...`;
  // Botón Pass: solo en tu turno, después de robar una carta
  $('btnPass').classList.toggle('hidden', !(isMyTurn && p.drawn));
  renderHand();
});

socket.on('unoCalled', ({ name }) => {
  $('statusMsg').textContent = `🔴 UNO! ${name} has one card left`;
  setTimeout(() => $('statusMsg').textContent = '', 2000);
});

socket.on('gameOver', ({ winner, winnerId }) => {
  const iWon = winnerId === myId;
  $('statusMsg').textContent = iWon ? '🏆 You won the game!' : `🏆 ${winner} won the game!`;
  $('btnRematch').classList.remove('hidden');
});

socket.on('opponentLeft', ({ name }) => {
  $('statusMsg').textContent = `${name} disconnected 😢`;
  $('btnRematch').classList.add('hidden');
  setTimeout(() => {
    $('game').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    $('lobbyError').textContent = 'The room closed. Create a new game.';
  }, 2500);
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

// Botón UNO
$('btnUno').onclick = () => socket.emit('sayUno');

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

  const oppId = Object.keys(pub.names).find(id => id !== myId);
  if (oppId) {
    $('oppName').textContent = pub.names[oppId];
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
  $('btnUno').classList.toggle('hidden', myHand.length !== 1);
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
