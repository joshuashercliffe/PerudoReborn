'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
const socket1 = io();

const PLAYER_COLORS = ['#60a5fa','#f87171','#4ade80','#d97706','#c084fc','#fb923c','#2dd4bf','#f472b6'];

const DIE_LAYOUT = {
  1: [0,0,0, 0,1,0, 0,0,0],
  2: [0,0,1, 0,0,0, 1,0,0],
  3: [0,0,1, 0,1,0, 1,0,0],
  4: [1,0,1, 0,0,0, 1,0,1],
  5: [1,0,1, 0,1,0, 1,0,1],
  6: [1,0,1, 1,0,1, 1,0,1],
};

const FACE_NAME = ['', '1s', '2s', '3s', '4s', '5s', '6s'];

const FACE3_TRANSFORMS = {
  1: 'rotateX(0deg) rotateY(0deg)',
  2: 'rotateY(-90deg)',
  3: 'rotateX(-90deg)',
  4: 'rotateX(90deg)',
  5: 'rotateY(90deg)',
  6: 'rotateY(180deg)',
};

function makeDie(value, extraClass = '') {
  const layout = DIE_LAYOUT[value] || DIE_LAYOUT[1];
  const dots = layout.map(on => `<span class="dot${on ? '' : ' empty'}"></span>`).join('');
  return `<div class="die${extraClass ? ' ' + extraClass : ''}">${dots}</div>`;
}

function makeColoredDie(value, color, extraClass = '') {
  const layout = DIE_LAYOUT[value] || DIE_LAYOUT[1];
  const dots = layout.map(on => `<span class="dot${on ? '' : ' empty'}"></span>`).join('');
  return `<div class="die${extraClass ? ' ' + extraClass : ''}" style="--dot-color:${color};box-shadow:0 3px 10px rgba(0,0,0,.4),0 0 0 2px ${color}44,0 1px 0 #ccc">${dots}</div>`;
}

fetch('/version').then(r => r.json()).then(({ version, deployedAt }) => {
  const date = new Date(deployedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  document.getElementById('build-info').textContent = `v${version} · ${date}`;
}).catch(() => {});

// ─── Per-player state ─────────────────────────────────────────────────────────
// PS[0] = player 1 (primary), PS[1] = player 2 (null until dual mode activated)
const PS = [
  { socket: socket1, id: null, name: null, dice: [], autoLiar: false },
  null,
];
let activeIdx     = 0;   // which player the UI is currently controlling
let dualMode      = false;

// Shared game state
let gs             = null;
let selQty         = 1;
let selFace        = 2;
let bidHistory     = [];
let dealGeneration = 0;
let currentRoomId  = null;

// Active player helpers
const p     = () => PS[activeIdx];
const pid   = () => p()?.id;
const pname = () => p()?.name;
const pdice = () => p()?.dice ?? [];
const pauto = () => p()?.autoLiar ?? false;

// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('connect', () => {
  PS[0].id = socket1.id;
  const token = localStorage.getItem('perudoSession');
  if (token) socket1.emit('rejoin', { sessionToken: token });
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showEl(id) { const el = typeof id === 'string' ? document.getElementById(id) : id; el?.classList.remove('hidden'); }
function hideEl(id) { const el = typeof id === 'string' ? document.getElementById(id) : id; el?.classList.add('hidden');    }

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ` toast-${type}` : '');
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  requestAnimationFrame(() => {
    t.classList.add('show');
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side bid validation (mirrors server — for UX hints only)
// ─────────────────────────────────────────────────────────────────────────────
function clientValidate(state, qty, face) {
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, why: 'Qty must be ≥ 1' };

  if (state.isFaceoff) {
    if (qty > 12) return { ok: false, why: 'Sum cannot exceed 12' };
    const cur = state.currentBid;
    if (!cur) return { ok: true };
    if (qty <= cur.quantity) return { ok: false, why: 'Must bid a higher sum' };
    return { ok: true };
  }

  if (!Number.isInteger(face) || face < 1 || face > 6) return { ok: false, why: 'Invalid face' };

  const cur = state.currentBid;
  if (!cur) {
    if (!state.isPalifico && face === 1) return { ok: false, why: 'Cannot open with 1s' };
    return { ok: true };
  }
  if (state.isPalifico) {
    if (pdice().length === 1) {
      if (qty > cur.quantity) return { ok: true };
      if (qty === cur.quantity && face > cur.face) return { ok: true };
      return { ok: false, why: 'Must raise quantity or bid same quantity of higher face' };
    }
    if (state.palificoFace !== null && face !== state.palificoFace)
      return { ok: false, why: `Palifico: must bid ${state.palificoFace}s` };
    if (qty <= cur.quantity) return { ok: false, why: 'Palifico: must raise quantity' };
    return { ok: true };
  }
  if (cur.face !== 1 && face === 1) {
    const min = Math.floor(cur.quantity / 2) + 1;
    return qty >= min ? { ok: true } : { ok: false, why: `Need ≥ ${min} ones to switch` };
  }
  if (cur.face === 1 && face !== 1) {
    const min = cur.quantity * 2;
    return qty >= min ? { ok: true } : { ok: false, why: `Need ≥ ${min} to leave 1s` };
  }
  if (qty > cur.quantity) return { ok: true };
  if (qty === cur.quantity && face > cur.face) return { ok: true };
  return { ok: false, why: 'Must be strictly higher' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen: Landing
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('btn-create-game').addEventListener('click', () => {
  socket1.emit('create_room');
});

const roomCodeInput = document.getElementById('room-code-input');
roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
});
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitJoinGame(); });
document.getElementById('btn-join-game').addEventListener('click', submitJoinGame);

function submitJoinGame() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) { roomCodeInput.focus(); return; }
  hideEl('landing-error');
  socket1.emit('join_game', { roomId: code });
}

socket1.on('room_created', ({ roomId }) => {
  currentRoomId = roomId;
  showScreen('screen-name');
  document.getElementById('name-input').focus();
});

socket1.on('join_game_ok', ({ roomId }) => {
  currentRoomId = roomId;
  hideEl('landing-error');
  showScreen('screen-name');
  document.getElementById('name-input').focus();
});

socket1.on('join_error', ({ message }) => {
  showScreen('screen-landing');
  const errEl = document.getElementById('landing-error');
  errEl.textContent = message;
  showEl('landing-error');
});

// ─────────────────────────────────────────────────────────────────────────────
// Screen: Name
// ─────────────────────────────────────────────────────────────────────────────
const nameInput = document.getElementById('name-input');
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });
document.getElementById('name-submit').addEventListener('click', submitName);

function submitName() {
  const n = nameInput.value.trim();
  if (!n) { nameInput.focus(); return; }
  hideEl('name-error');
  socket1.emit('set_name', { name: n });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lobby
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('joined_lobby', state => {
  if (state.sessionToken) localStorage.setItem('perudoSession', state.sessionToken);
  if (state.roomId) currentRoomId = state.roomId;
  PS[0].id   = socket1.id;
  PS[0].name = state.players.find(pl => pl.id === PS[0].id)?.name ?? null;
  gs = state;
  showScreen('screen-lobby');
  renderLobby(state);

  // Trigger dual-player mode when username is Davetest
  if (PS[0].name?.toLowerCase() === 'davetest' && !dualMode) {
    showEl('p2-setup');
  }
});

socket1.on('rejoined', ({ sessionToken, roomId, state, dice, phase }) => {
  localStorage.setItem('perudoSession', sessionToken);
  if (roomId) currentRoomId = roomId;
  PS[0].id   = socket1.id;
  gs         = state;
  PS[0].name = state.players.find(pl => pl.id === PS[0].id)?.name ?? null;
  PS[0].dice = dice || [];

  if (phase === 'lobby') {
    showScreen('screen-lobby');
    renderLobby(state);
  } else if (phase === 'over') {
    const w = state.players[0]?.name ?? '';
    const victoryQuips = [
      `👑 ${w} has conquered the table and claimed victory`,
      `🎲 ${w} has become statistically unstoppable`,
      `🔥 ${w} turned pure luck into total domination`,
    ];
    document.getElementById('winner-name').textContent =
      victoryQuips[Math.floor(Math.random() * victoryQuips.length)];
    showScreen('screen-over');
  } else {
    if (phase === 'playing') hideEl('reveal-overlay');
    showScreen('screen-game');
    renderGame();
  }
  toast('Reconnected!', 'ok');
});

socket1.on('rejoin_failed', () => {
  localStorage.removeItem('perudoSession');
  showScreen('screen-landing');
});

socket1.on('lobby_update', state => {
  gs = state;
  if (document.getElementById('screen-lobby').classList.contains('active')) {
    renderLobby(state);
  } else if (document.getElementById('screen-over').classList.contains('active')) {
    if (state.players.some(pl => pl.id === PS[0].id)) {
      showScreen('screen-lobby');
      renderLobby(state);
    } else {
      localStorage.removeItem('perudoSession');
      showScreen('screen-landing');
    }
  }
});

function renderLobby(state) {
  if (currentRoomId) {
    document.getElementById('room-code-value').textContent = currentRoomId;
  }

  const iAmLobbyHost = pid() === state.host;
  document.getElementById('lobby-players').innerHTML = state.players.map(pl => {
    const isHost  = pl.id === state.host;
    const isMe    = pl.id === pid();
    const canKick = iAmLobbyHost && !pl.connected && !isMe;
    return `<div class="lobby-player${isHost ? ' is-host' : ''}${!pl.connected ? ' disconnected' : ''}">
      <span class="player-name">${esc(pl.name)}${!pl.connected ? ' <span class="muted-msg">(disconnected)</span>' : ''}</span>
      <div style="display:flex;gap:6px;align-items:center">
        ${isHost ? '<span class="host-chip">Host</span>' : ''}
        ${isMe   ? '<span class="you-chip">You</span>'  : ''}
        ${canKick ? `<button class="btn-kick" data-id="${esc(pl.id)}">Kick</button>` : ''}
      </div>
    </div>`;
  }).join('');

  const modeDescs = {
    standard: '5 dice each — lose a die when you lose a round',
    reverse:  '1 die each — gain a die when you lose, go above 5 and you\'re out'
  };
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.gameMode);
  });
  document.getElementById('mode-desc').textContent = modeDescs[state.gameMode] ?? '';

  const varBtn = document.getElementById('btn-variable');
  varBtn.dataset.active = state.isVariable ? 'true' : 'false';
  varBtn.classList.toggle('active', !!state.isVariable);

  const startBtn  = document.getElementById('btn-start');
  const hint      = document.getElementById('start-hint');
  const amInLobby = state.players.some(pl => pl.id === PS[0].id);
  if (amInLobby) {
    showEl(startBtn);
    if (state.players.length < 2) {
      startBtn.disabled = true;
      hint.textContent = 'Waiting for at least 2 players…';
    } else {
      startBtn.disabled = false;
      hint.textContent = `${state.players.length} players ready — anyone can start!`;
    }
  } else {
    hideEl(startBtn);
    hint.textContent = '';
  }
}

document.getElementById('btn-start').addEventListener('click', () => p().socket.emit('start_game'));
document.getElementById('btn-leave-lobby').addEventListener('click', () => p().socket.emit('leave_lobby'));
document.getElementById('lobby-players').addEventListener('click', e => {
  const btn = e.target.closest('.btn-kick');
  if (btn) p().socket.emit('kick_player', { playerId: btn.dataset.id });
});
socket1.on('start_error', ({ message }) => toast(message, 'error'));

document.getElementById('mode-btns').addEventListener('click', e => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  p().socket.emit('set_mode', { mode: btn.dataset.mode });
});

document.getElementById('btn-copy-code').addEventListener('click', () => {
  if (!currentRoomId) return;
  navigator.clipboard?.writeText(currentRoomId).then(() => toast('Code copied!', 'ok'));
});

document.getElementById('btn-variable').addEventListener('click', function() {
  const newVal = this.dataset.active !== 'true';
  p().socket.emit('set_variable', { value: newVal });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dual-player: P2 setup + toggle
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('btn-add-p2').addEventListener('click', () => {
  const name = document.getElementById('p2-name-input').value.trim() || 'Player 2';
  initPlayer2(name);
  hideEl('p2-setup');
});
document.getElementById('p2-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-add-p2').click();
});

function initPlayer2(name) {
  const socket2 = io();
  PS[1] = { socket: socket2, id: null, name: null, dice: [], autoLiar: false };
  dualMode = true;
  document.body.classList.add('dual-mode');
  showEl('player-toggle');
  updateToggleLabels();

  socket2.on('connect', () => {
    PS[1].id = socket2.id;
    socket2.emit('join_game', { roomId: currentRoomId });
  });

  socket2.on('join_game_ok', () => {
    socket2.emit('set_name', { name });
  });

  socket2.on('join_error', ({ message }) => {
    toast(`P2: ${message}`, 'error');
  });

  socket2.on('joined_lobby', state => {
    PS[1].id   = socket2.id;
    PS[1].name = state.players.find(pl => pl.id === socket2.id)?.name ?? name;
    gs = state;
    updateToggleLabels();
    renderLobby(state);
  });

  // socket2 receives `your_dice` individually; all other game events are
  // handled by socket1's listeners which already update both PS[0] and PS[1]
  socket2.on('your_dice', ({ dice }) => {
    PS[1].dice = dice;
    if (activeIdx === 1) dealMyDice();
  });
}

function updateToggleLabels() {
  const b0 = document.getElementById('toggle-p0');
  const b1 = document.getElementById('toggle-p1');
  b0.textContent = `P1: ${PS[0]?.name ?? '—'}`;
  b1.textContent = `P2: ${PS[1]?.name ?? '—'}`;
  b0.classList.toggle('ptoggle-active', activeIdx === 0);
  b1.classList.toggle('ptoggle-active', activeIdx === 1);
}

function switchPlayer(idx) {
  if (!PS[idx]) return;
  activeIdx = idx;
  updateToggleLabels();
  if (document.getElementById('screen-lobby').classList.contains('active') && gs) {
    renderLobby(gs);
  } else if (gs && (gs.phase === 'playing' || gs.phase === 'reveal')) {
    renderGame();
  }
}

document.getElementById('toggle-p0').addEventListener('click', () => switchPlayer(0));
document.getElementById('toggle-p1').addEventListener('click', () => switchPlayer(1));

// ─────────────────────────────────────────────────────────────────────────────
// Face picker
// ─────────────────────────────────────────────────────────────────────────────
(function initFacePicker() {
  const picker = document.getElementById('face-picker');
  picker.innerHTML = [1,2,3,4,5,6].map(f =>
    `<button class="face-btn" data-face="${f}">${makeDie(f)}</button>`
  ).join('');

  picker.addEventListener('click', e => {
    const btn = e.target.closest('.face-btn');
    if (!btn || btn.disabled) return;
    selFace = parseInt(btn.dataset.face, 10);
    refreshBidControls();
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Game — round start
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('round_start', state => {
  gs = state;
  PS[0].dice     = [];
  PS[0].autoLiar = (state.autoLiarPlayerId === PS[0].id);
  if (PS[1]) {
    PS[1].dice     = [];
    PS[1].autoLiar = (state.autoLiarPlayerId === PS[1].id);
  }
  bidHistory = [];
  hideEl('reveal-overlay');
  showScreen('screen-game');
  renderGame();
  renderBidHistory();
  if (state.isFaceoff) showFaceoffAnnounce();
  else if (state.isPalifico) showPalificoAnnounce(state.currentPlayerName);
});

function showPalificoAnnounce(triggerName) {
  const overlay = document.getElementById('palifico-overlay');
  document.getElementById('palifico-sub').textContent =
    `${triggerName} has one die — no wilds this round!`;

  ['palifico-text', 'palifico-sub'].forEach(id => {
    const el = document.getElementById(id);
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });

  showEl(overlay);
  setTimeout(() => hideEl(overlay), 2000);
}

function showFaceoffAnnounce() {
  const overlay = document.getElementById('faceoff-overlay');
  document.getElementById('faceoff-sub').textContent = '1v1 — bid the sum of both dice!';
  ['faceoff-text', 'faceoff-sub'].forEach(id => {
    const el = document.getElementById(id);
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });
  showEl(overlay);
  setTimeout(() => hideEl(overlay), 2500);
}

socket1.on('your_dice', ({ dice }) => {
  PS[0].dice = dice;
  if (activeIdx === 0) dealMyDice();
});

// ─────────────────────────────────────────────────────────────────────────────
// Game rendering
// ─────────────────────────────────────────────────────────────────────────────
function renderGame() {
  renderPlayersBar();
  renderBidDisplay();
  renderQuickMaths();
  renderStatus();
  renderMyDice();
  renderActionUI();
  renderAutoLiarBtn();
  renderReactionButtons();
}

function renderPlayersBar() {
  const iAmHost = pid() === gs.host;
  document.getElementById('players-bar').innerHTML = gs.players.map(pl => {
    const active   = pl.id === gs.currentPlayerId;
    const me       = pl.id === pid();
    const canKick  = iAmHost && !pl.connected && !me;
    return `<div class="player-chip${active ? ' is-active' : ''}${me ? ' is-me' : ''}${!pl.connected ? ' disconnected' : ''}">
      <div class="chip-name" title="${esc(pl.name)}">${esc(pl.name)}${me ? ' ★' : ''}</div>
      <div class="chip-dice">${pl.diceCount} 🎲</div>
      ${active ? '<div class="chip-turn">▶ turn</div>' : ''}
      ${canKick ? `<button class="btn-kick" data-id="${esc(pl.id)}">Kick</button>` : ''}
    </div>`;
  }).join('');

  document.getElementById('round-label').textContent = `Round ${gs.roundNumber}`;
  gs.gameMode === 'reverse' ? showEl('mode-badge') : hideEl('mode-badge');
  gs.isPalifico && !gs.isFaceoff ? showEl('palifico-badge') : hideEl('palifico-badge');
  gs.isFaceoff ? showEl('faceoff-badge') : hideEl('faceoff-badge');
}

function renderBidDisplay() {
  const valEl = document.getElementById('bid-display-value');
  const byEl  = document.getElementById('bid-display-by');
  if (gs.currentBid) {
    const { quantity, face } = gs.currentBid;
    if (gs.isFaceoff) {
      valEl.innerHTML = `<span class="bid-qty">${quantity}</span>`;
      byEl.textContent = 'sum bid';
    } else {
      valEl.innerHTML = `<span class="bid-qty">${quantity}</span><span class="bid-x">×</span>${makeDie(face, 'bid-die')}`;
      byEl.textContent = 'bid in play';
    }
    valEl.classList.add('pop');
    valEl.addEventListener('animationend', () => valEl.classList.remove('pop'), { once: true });
  } else {
    valEl.innerHTML = '<span class="bid-qty empty">—</span>';
    byEl.textContent = gs.isFaceoff ? 'no sum yet' : 'no bid yet';
  }
}

function renderQuickMaths() {
  const qmBox = document.getElementById('quick-maths');
  const label = qmBox.querySelector('.info-label');
  if (gs.isFaceoff) {
    label.textContent = 'Sum Range';
    document.getElementById('qm-value').textContent = '2–12';
    document.getElementById('total-dice-note').textContent = '';
  } else {
    label.textContent = 'Quick Maths';
    const total = gs.players.reduce((s, pl) => s + pl.diceCount, 0);
    const qm = total / 3;
    document.getElementById('qm-value').textContent = Number.isInteger(qm) ? String(qm) : qm.toFixed(2);
    document.getElementById('total-dice-note').textContent = ` (${total} dice in play)`;
  }
}

function renderStatus() {
  const bar = document.getElementById('status-bar');
  if (gs.currentPlayerId === pid()) {
    if (gs.isFaceoff) {
      bar.textContent = gs.firstBidOfRound ? 'Faceoff — bid the sum of both dice!' : 'Your turn — bid higher!';
    } else {
      bar.textContent = gs.firstBidOfRound ? 'Your turn — open the bidding!' : 'Your turn!';
    }
    bar.className = 'my-turn';
  } else {
    bar.textContent = `${gs.currentPlayerName}'s turn…`;
    bar.className = 'waiting';
  }
}

function renderBidHistory() {
  const list = document.getElementById('bid-history-list');
  if (!bidHistory.length) {
    list.innerHTML = '<span class="muted-msg" style="padding:4px 6px;font-size:.85rem">No bids yet this round</span>';
    return;
  }
  list.innerHTML = bidHistory.map(e => {
    if (e.type === 'liar') {
      return `<div class="bid-history-entry">
        <span class="bhe-name">${esc(e.name)}</span>
        <span class="bhe-arrow">→</span>
        <span class="bhe-liar">LIAR!</span>
      </div>`;
    }
    if (e.face === null) {
      return `<div class="bid-history-entry">
        <span class="bhe-name">${esc(e.name)}</span>
        <span class="bhe-arrow">→</span>
        <span class="bhe-bid">Sum: <strong>${e.qty}</strong></span>
      </div>`;
    }
    return `<div class="bid-history-entry">
      <span class="bhe-name">${esc(e.name)}</span>
      <span class="bhe-arrow">→</span>
      <span class="bhe-bid"><strong>${e.qty}</strong> × ${makeDie(e.face, 'small')}</span>
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function die3FacesHtml() {
  return [1,2,3,4,5,6].map(f => {
    const dots = (DIE_LAYOUT[f]||DIE_LAYOUT[1]).map(on=>`<span class="dot${on?'':' empty'}"></span>`).join('');
    return `<div class="die3-face die3-f${f}">${dots}</div>`;
  }).join('');
}

function make3DDie(value) {
  const t = FACE3_TRANSFORMS[value] || FACE3_TRANSFORMS[1];
  return `<div class="die3-wrap"><div class="die3" style="transform:${t}">${die3FacesHtml()}</div></div>`;
}

function randomTumble() {
  const r = () => Math.floor(30 + Math.random() * 330);
  return `rotateX(${r()}deg) rotateY(${r()}deg) rotateZ(${Math.floor(Math.random()*360)}deg)`;
}

function renderMyDice() {
  dealGeneration++;
  document.getElementById('my-dice').innerHTML =
    [...pdice()].sort((a, b) => a - b).map(d => make3DDie(d)).join('');
}

function dealMyDice() {
  const gen = ++dealGeneration;
  const container = document.getElementById('my-dice');
  const finalDice = [...pdice()].sort((a, b) => a - b);
  if (!finalDice.length) { container.innerHTML = ''; return; }

  const facesHtml = die3FacesHtml();
  container.innerHTML = finalDice.map(() =>
    `<div class="die3-wrap"><div class="die3">${facesHtml}</div></div>`
  ).join('');

  const cubes = [...container.querySelectorAll('.die3')];
  const wraps = [...container.querySelectorAll('.die3-wrap')];

  cubes.forEach(c => { c.style.transition = 'none'; c.style.transform = randomTumble(); });

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen !== dealGeneration) return;
    cubes.forEach((c, i) => {
      c.style.transition = 'transform 480ms cubic-bezier(0.34,1.56,0.64,1)';
      c.style.transform = FACE3_TRANSFORMS[finalDice[i]];
    });
    wraps.forEach((w, i) => {
      w.style.animationDelay = `${i * 90}ms`;
      w.classList.add('die3-landing');
    });
  }));
}

function renderAutoLiarBtn() {
  const isMyTurn  = gs.currentPlayerId === pid();
  const isPlaying = gs.phase === 'playing';
  if (isPlaying && !isMyTurn && !gs.isFaceoff) {
    showEl('autoliar-section');
    const btn = document.getElementById('btn-autoliar');
    if (pauto()) {
      btn.textContent = '✓ AUTOLIAR LOCKED';
      btn.classList.add('autoliar-locked');
      btn.disabled = true;
    } else {
      btn.textContent = '🔒 Lock in Autoliar';
      btn.classList.remove('autoliar-locked');
      btn.disabled = false;
    }
  } else {
    hideEl('autoliar-section');
  }
}

function renderReactionButtons() {
  if (gs.phase === 'playing' && pdice().length > 0) {
    showEl('reaction-buttons');
  } else {
    hideEl('reaction-buttons');
  }
}

function renderActionUI() {
  const isMyTurn = gs.currentPlayerId === pid() && gs.phase === 'playing';
  if (!isMyTurn) { hideEl('action-ui'); return; }

  showEl('action-ui');
  gs.isPalifico && !gs.isFaceoff ? showEl('palifico-notice') : hideEl('palifico-notice');

  if (gs.isFaceoff) {
    document.getElementById('qty-label').textContent = 'Bid Sum';
    hideEl('face-control');
    selQty = gs.currentBid ? gs.currentBid.quantity + 1 : 2;
  } else {
    document.getElementById('qty-label').textContent = 'Quantity';
    showEl('face-control');
    if (gs.currentBid) {
      selQty  = gs.currentBid.quantity;
      selFace = gs.currentBid.face ?? 2;
    } else {
      selQty  = 1;
      selFace = 2;
    }
  }
  refreshBidControls();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bid controls
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('qty-down').addEventListener('click', () => { selQty = Math.max(1, selQty - 1); refreshBidControls(); });
document.getElementById('qty-up').addEventListener('click',   () => { selQty = gs?.isFaceoff ? Math.min(12, selQty + 1) : selQty + 1; refreshBidControls(); });

function refreshBidControls() {
  document.getElementById('qty-val').textContent = selQty;

  if (gs.isFaceoff) {
    const v = clientValidate(gs, selQty, 0);
    document.getElementById('bid-hint-msg').textContent = v.ok ? '' : v.why;
    document.getElementById('btn-bid').disabled = !v.ok;
    document.getElementById('btn-challenge').disabled = gs.firstBidOfRound;
    return;
  }

  document.querySelectorAll('.face-btn').forEach(btn => {
    const f = parseInt(btn.dataset.face, 10);
    btn.classList.toggle('selected', f === selFace);

    if (gs.isPalifico && gs.palificoFace !== null && pdice().length > 1) {
      btn.disabled = (f !== gs.palificoFace);
    } else if (gs.firstBidOfRound && !gs.isPalifico) {
      btn.disabled = (f === 1);
    } else {
      btn.disabled = false;
    }
  });

  const v = clientValidate(gs, selQty, selFace);
  document.getElementById('bid-hint-msg').textContent = v.ok ? '' : v.why;
  document.getElementById('btn-bid').disabled = !v.ok;
  document.getElementById('btn-challenge').disabled = gs.firstBidOfRound;
}

document.getElementById('btn-bid').addEventListener('click', () => {
  p().socket.emit('make_bid', { quantity: selQty, face: gs.isFaceoff ? 0 : selFace });
});

document.getElementById('btn-challenge').addEventListener('click', () => {
  p().socket.emit('challenge');
});

document.getElementById('players-bar').addEventListener('click', e => {
  const btn = e.target.closest('.btn-kick');
  if (btn) p().socket.emit('kick_player', { playerId: btn.dataset.id });
});

document.getElementById('btn-autoliar').addEventListener('click', () => {
  p().socket.emit('auto_liar');
});

document.getElementById('btn-react-fire').addEventListener('click', () => {
  p().socket.emit('reaction', { type: 'fire' });
});
document.getElementById('btn-react-ice').addEventListener('click', () => {
  p().socket.emit('reaction', { type: 'ice' });
});

function spawnFloatingEmoji(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  const leftPct = 5 + Math.random() * 88;
  const driftPx = (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 50);
  el.style.left = leftPct + '%';
  el.style.setProperty('--drift-x', driftPx + 'px');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

socket1.on('reaction', ({ type }) => {
  spawnFloatingEmoji(type === 'fire' ? '🔥' : '🧊');
});

// ─────────────────────────────────────────────────────────────────────────────
// Wild opening bid — WOAH overlay
// ─────────────────────────────────────────────────────────────────────────────
function showWoahOverlay(aboveBy) {
  const overlay  = document.getElementById('woah-overlay');
  const phase1   = document.getElementById('woah-phase1');
  const phase2   = document.getElementById('woah-phase2');
  const aboveEl  = document.getElementById('woah-above');
  const wrap     = document.getElementById('woah-img-wrap');

  showEl(phase1);
  hideEl(phase2);
  aboveEl.textContent = `${aboveBy} above quick math??`;

  wrap.style.animation = 'none';
  void wrap.offsetWidth;
  wrap.style.animation = '';

  showEl(overlay);

  setTimeout(() => {
    hideEl(phase1);

    aboveEl.style.animation = 'none';
    document.getElementById('woah-send').style.animation = 'none';
    void aboveEl.offsetWidth;
    aboveEl.style.animation = '';
    document.getElementById('woah-send').style.animation = '';

    showEl(phase2);

    setTimeout(() => hideEl(overlay), 2500);
  }, 2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bid made
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('bid_made', ({ bid, bidderName, gameState: state }) => {
  const wasFirstBid = gs.firstBidOfRound;
  gs = state;
  PS[0].autoLiar = (state.autoLiarPlayerId === PS[0].id);
  if (PS[1]) PS[1].autoLiar = (state.autoLiarPlayerId === PS[1].id);
  bidHistory.push({ type: 'bid', name: bidderName, qty: bid.quantity, face: bid.face });
  renderGame();
  renderBidHistory();
  if (bidderName !== pname()) {
    if (state.isFaceoff) {
      toast(`${bidderName} bid sum ${bid.quantity}`);
    } else {
      toast(`${bidderName} bid ${bid.quantity} ${FACE_NAME[bid.face]}`);
    }
  }

  if (wasFirstBid && !state.isFaceoff) {
    const totalDice = state.players.reduce((s, pl) => s + pl.diceCount, 0);
    const quickMath = totalDice / 3;
    if (bid.quantity >= quickMath + 2) {
      showWoahOverlay(Math.round(bid.quantity - quickMath));
    }
  }
});

socket1.on('bid_error', ({ message }) => toast(message, 'error'));

// ─────────────────────────────────────────────────────────────────────────────
// LIAR called
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('liar_called', ({ challengerName, isPeak }) => {
  bidHistory.push({ type: 'liar', name: challengerName });

  if (isPeak) {
    showPeakOverlay(challengerName);
    return;
  }

  const overlay = document.getElementById('liar-overlay');
  document.getElementById('liar-caller').textContent = `${challengerName} called it!`;
  const liarText = document.getElementById('liar-text');
  liarText.style.animation = 'none';
  void liarText.offsetWidth;
  liarText.style.animation = '';
  showEl(overlay);
  setTimeout(() => hideEl(overlay), 1800);
});

let peakOverlayActive = false;
let pendingChallengeResult = null;

function showPeakOverlay(challengerName) {
  const overlay = document.getElementById('peak-overlay');
  document.getElementById('peak-sub').textContent = `${challengerName} just got PEAKED`;
  ['peak-mountain', 'peak-title', 'peak-sub'].forEach(id => {
    const el = document.getElementById(id);
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });
  peakOverlayActive = true;
  showEl(overlay);
  setTimeout(() => {
    hideEl(overlay);
    peakOverlayActive = false;
    if (pendingChallengeResult) {
      const result = pendingChallengeResult;
      pendingChallengeResult = null;
      showReveal(result);
    }
  }, 3500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Challenge reveal
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('challenge_result', result => {
  hideEl('action-ui');
  hideEl('liar-overlay');
  hideEl('woah-overlay');
  if (peakOverlayActive) {
    pendingChallengeResult = result;
    return;
  }
  hideEl('peak-overlay');
  showReveal(result);
});

socket1.on('reveal_resolved', () => {
  showEl('btn-next-round');
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  hideEl('btn-next-round');
  p().socket.emit('next_round');
});

function showReveal(r) {
  const { revealedDice, bid, count, bidMet, isPeak, diceDelta, isPalifico, isFaceoff, gameMode, bidderName, challengerName, loserName } = r;

  let playersRowHtml, bottomRowHtml;

  if (isFaceoff) {
    playersRowHtml = revealedDice.map(pd => {
      const color = PLAYER_COLORS[pd.colorIndex ?? 0];
      const isMe  = pd.id === pid();
      const diceHtml = pd.dice.map(d => makeColoredDie(d, color, 'small')).join('');
      return `<div class="reveal-player-section">
        <div class="reveal-player-name" style="color:${color}">${esc(pd.name)}${isMe ? ' ★' : ''}</div>
        <div class="reveal-player-dice">${diceHtml}</div>
      </div>`;
    }).join('');
    bottomRowHtml = `
      <div class="reveal-bid-row" style="flex-direction:row; gap:32px; align-items:flex-end">
        <div style="display:flex; flex-direction:column; align-items:center">
          <span class="reveal-bid-label">Actual Sum</span>
          <span class="reveal-bid-sum">${count}</span>
        </div>
        <div style="display:flex; flex-direction:column; align-items:center">
          <span class="reveal-bid-label">Bid</span>
          <span class="reveal-bid-sum" style="color:var(--gold)">${bid.quantity}</span>
        </div>
      </div>`;
  } else {
    playersRowHtml = revealedDice.map(pd => {
      const color = PLAYER_COLORS[pd.colorIndex ?? 0];
      const isMe  = pd.id === pid();
      const relevant = [...pd.dice]
        .filter(d => d === bid.face || (!isPalifico && d === 1 && bid.face !== 1))
        .sort((a, b) => a - b);
      if (!relevant.length) return '';
      const diceHtml = relevant.map(d => makeColoredDie(d, color, 'small')).join('');
      return `<div class="reveal-player-section">
        <div class="reveal-player-name" style="color:${color}">${esc(pd.name)}${isMe ? ' ★' : ''}</div>
        <div class="reveal-player-dice">${diceHtml}</div>
      </div>`;
    }).join('');
    const bidDiceHtml = Array.from({ length: bid.quantity }, () => makeDie(bid.face, 'small')).join('');
    bottomRowHtml = `
      <div class="reveal-bid-row">
        <span class="reveal-bid-label">Bid</span>
        <div class="reveal-bid-dice">${bidDiceHtml}</div>
      </div>`;
  }

  const loserQuips = isFaceoff ? [
    `💀 ${esc(loserName)} lost the ultimate 1v1 showdown`,
    `💀 ${esc(loserName)} miscounted in the final moment`,
    `💀 ${esc(loserName)} failed their arithmetic exam`,
    `💀 ${esc(loserName)} went down swinging in the faceoff`,
    `💀 ${esc(loserName)} couldn't survive the duel`,
  ] : gameMode === 'reverse' ? [
    `📈 ${esc(loserName)} is collecting dice like they cost nothing`,
    `📦 ${esc(loserName)} added to their growing problem`,
    `🎲 ${esc(loserName)} has too many dice and not enough skill`,
    `🚨 ${esc(loserName)} is getting dangerously overstocked`,
    `🔢 ${esc(loserName)} raised the quick maths the wrong way`,
  ] : [
    `💀 ${esc(loserName)} angered the dice gods and paid the tax`,
    `💀 ${esc(loserName)} just lowered quick maths`,
    `💀 ${esc(loserName)} got audited by RNGesus`,
    `💀 ${esc(loserName)} experienced a critical skill issue`,
    `💀 ${esc(loserName)} is on their way straight home`,
    `💀 ${esc(loserName)} lost a die to budget cuts`,
  ];
  const loserLine = loserQuips[Math.floor(Math.random() * loserQuips.length)];

  const diceWord = (diceDelta ?? 1) === 1 ? 'die' : 'dice';
  const diceLossText = gameMode === 'reverse'
    ? ` — gains ${diceDelta ?? 1} ${diceWord}`
    : ` — loses ${diceDelta ?? 1} ${diceWord}`;
  const outcomeText = isFaceoff
    ? (bidMet
        ? `✗ Call unsuccessful — sum is ${count} ≥ ${bid.quantity}, <strong>${esc(challengerName)}</strong> loses`
        : `✓ Call successful — sum is ${count}, bid was ${bid.quantity}, <strong>${esc(bidderName)}</strong> loses`)
    : (bidMet
        ? `✗ Call unsuccessful — <strong>${esc(challengerName)}</strong>${diceLossText}`
        : `✓ Call successful — <strong>${esc(bidderName)}</strong>${diceLossText}`);

  const countLine = isFaceoff ? '' :
    `<div class="reveal-count-line">There were actually <strong>${count}</strong> ${FACE_NAME[bid.face]}</div>`;
  const peakLine = (!isFaceoff && isPeak)
    ? `<div class="reveal-count-line">The peak was <strong>${bid.quantity}</strong> ${FACE_NAME[bid.face]}</div>`
    : '';

  document.getElementById('reveal-all-dice').innerHTML = `
    <div class="reveal-players-row">${playersRowHtml}</div>
    ${countLine}
    ${peakLine}
    ${bottomRowHtml}`;

  document.getElementById('reveal-summary').innerHTML = `
    <div class="reveal-outcome ${bidMet ? 'lose' : 'win'}">${outcomeText}</div>
    <div class="reveal-loser-line">${loserLine}</div>`;

  hideEl('btn-next-round');
  showEl('reveal-overlay');
}

// ─────────────────────────────────────────────────────────────────────────────
// Elimination
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('player_eliminated', ({ playerId, playerName, reason }) => {
  if (playerId === PS[0].id) {
    PS[0].dice = [];
    if (activeIdx === 0) renderReactionButtons();
  }
  if (PS[1] && playerId === PS[1].id) {
    PS[1].dice = [];
    if (activeIdx === 1) renderReactionButtons();
  }
  if (reason === 'disconnect') {
    const disconnectQuips = [
      `${playerName} lagged out of reality`,
      `${playerName} lost connection faster than they lost the game`,
      `${playerName} has been claimed by unstable Wi-Fi`,
      `${playerName} timed out while searching for better luck`,
      `${playerName} has been defeated by ping`,
    ];
    toast(disconnectQuips[Math.floor(Math.random() * disconnectQuips.length)], 'warn');
  } else if (reason === 'kick') {
    toast(`${playerName} was kicked by the host`, 'warn');
  }
  animateElimination(playerName);
});

function animateElimination(name) {
  const eliminationQuips = [
    `${name} has been sent straight home!`,
    `${name} is out of the game and into the history books`,
    `${name} is officially out of dice and out of hope`,
    `${name} has been voted off the island by RNG`,
    `${name} is no longer among the rolling`,
  ];
  document.getElementById('elimination-name').textContent =
    eliminationQuips[Math.floor(Math.random() * eliminationQuips.length)];

  const container = document.getElementById('dice-particles');
  container.innerHTML = '';

  const DICE_EMOJI = ['⚀','⚁','⚂','⚃','⚄','⚅'];
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'dice-particle';
    p.textContent = DICE_EMOJI[Math.floor(Math.random() * 6)];

    const angle = Math.random() * Math.PI * 2;
    const dist  = 100 + Math.random() * 240;
    p.style.setProperty('--ex',    `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--ey',    `${Math.sin(angle) * dist}px`);
    p.style.setProperty('--dur',   `${(.7 + Math.random() * .9).toFixed(2)}s`);
    p.style.setProperty('--delay', `${(Math.random() * .35).toFixed(2)}s`);
    container.appendChild(p);
  }

  showEl('elimination-overlay');
  setTimeout(() => hideEl('elimination-overlay'), 3200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Game over
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('auto_liar_update', ({ playerId, playerName }) => {
  if (playerId === PS[0].id) {
    PS[0].autoLiar = true;
    if (activeIdx === 0) renderAutoLiarBtn();
  }
  if (PS[1] && playerId === PS[1].id) {
    PS[1].autoLiar = true;
    if (activeIdx === 1) renderAutoLiarBtn();
  }
  showAutoLiarOverlay(playerName);
});

function showAutoLiarOverlay(playerName) {
  const overlay = document.getElementById('autoliar-overlay');
  document.getElementById('autoliar-overlay-sub').textContent = `${playerName} has locked it in`;
  const textEl = document.getElementById('autoliar-overlay-text');
  [textEl, document.getElementById('autoliar-overlay-sub')].forEach(el => {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });
  showEl(overlay);
  setTimeout(() => hideEl(overlay), 2000);
}

socket1.on('game_over', ({ winner, reason, quitterName }) => {
  hideEl('reveal-overlay');
  hideEl('ragequit-overlay');
  PS[0].autoLiar = false;
  if (PS[1]) PS[1].autoLiar = false;
  const titleEl = document.getElementById('winner-title');
  const nameEl  = document.getElementById('winner-name');

  if (reason === 'rage_quit') {
    titleEl.textContent = 'Game Over';
    const rageQuips = [
      `${quitterName} has ended the game and fled the scene`,
      `${quitterName} has rage quit before the RCMP could arrive`,
      `${quitterName} ended the game to avoid further emotional damage`,
      `${quitterName} has ended the game. The dice may now rest`,
    ];
    nameEl.textContent = rageQuips[Math.floor(Math.random() * rageQuips.length)];
  } else {
    titleEl.textContent = 'Winner!';
    const victoryQuips = [
      `👑 ${winner} has conquered the table and claimed victory`,
      `🎲 ${winner} has become statistically unstoppable`,
      `🔥 ${winner} turned pure luck into total domination`,
    ];
    nameEl.textContent = victoryQuips[Math.floor(Math.random() * victoryQuips.length)];
  }

  setTimeout(() => showScreen('screen-over'), 600);
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  p().socket.emit('leave_room');
});

socket1.on('game_reset', () => {
  localStorage.removeItem('perudoSession');
  PS[0].name     = null;
  PS[0].dice     = [];
  PS[0].autoLiar = false;
  gs             = null;
  bidHistory     = [];
  currentRoomId  = null;

  if (dualMode) {
    PS[1]?.socket.disconnect();
    PS[1]  = null;
    dualMode   = false;
    activeIdx  = 0;
    document.body.classList.remove('dual-mode');
    hideEl('player-toggle');
    updateToggleLabels();
  }

  document.getElementById('name-input').value      = '';
  document.getElementById('room-code-input').value = '';
  hideEl('p2-setup');
  showScreen('screen-landing');
});

// ── End Game / Rage Quit ──────────────────────────────────────────────────────
document.getElementById('btn-end-game').addEventListener('click', () => {
  showEl('ragequit-overlay');
});
document.getElementById('btn-ragequit-no').addEventListener('click', () => {
  hideEl('ragequit-overlay');
});
document.getElementById('btn-ragequit-yes').addEventListener('click', () => {
  hideEl('ragequit-overlay');
  p().socket.emit('rage_quit');
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('player_disconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} has disconnected`, 'warn');
  if (gs?.phase === 'playing' || gs?.phase === 'reveal') renderGame();
});

socket1.on('player_reconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} reconnected`, 'ok');
  if (gs?.phase === 'playing' || gs?.phase === 'reveal') renderGame();
});

socket1.on('disconnect', () => toast('Connection lost — reconnecting…', 'warn'));
