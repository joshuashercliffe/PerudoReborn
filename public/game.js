'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
const socket = io();

const DICE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// Client state
let myId       = null;
let myName     = null;
let myRoom     = null;
let gs         = null;   // latest public game state from server
let myDice     = [];
let selQty     = 1;
let selFace    = 2;

socket.on('connect',   () => { myId = socket.id; });
socket.on('reconnect', () => { myId = socket.id; });

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showEl(id)  { const el = typeof id === 'string' ? document.getElementById(id) : id; el?.classList.remove('hidden'); }
function hideEl(id)  { const el = typeof id === 'string' ? document.getElementById(id) : id; el?.classList.add('hidden');    }

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ` toast-${type}` : '');
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  requestAnimationFrame(() => {
    t.classList.add('show');
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 2800);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side bid validation (mirrors server, for UX only)
// ─────────────────────────────────────────────────────────────────────────────
function clientValidate(state, qty, face) {
  if (!Number.isInteger(face) || face < 1 || face > 6) return { ok: false, why: 'Invalid face' };
  if (!Number.isInteger(qty) || qty < 1)               return { ok: false, why: 'Qty must be ≥ 1' };

  const cur = state.currentBid;
  if (!cur) {
    if (face === 1) return { ok: false, why: 'Cannot open with 1s' };
    return { ok: true };
  }
  if (state.isPalifico) {
    if (state.palificoFace !== null && face !== state.palificoFace)
      return { ok: false, why: `Palifico: must bid ${state.palificoFace}s` };
    if (qty <= cur.quantity) return { ok: false, why: 'Palifico: must raise quantity' };
    return { ok: true };
  }
  if (cur.face !== 1 && face === 1) {
    const min = Math.ceil(cur.quantity / 2);
    return qty >= min ? { ok: true } : { ok: false, why: `Need ≥ ${min} ones to switch` };
  }
  if (cur.face === 1 && face !== 1) {
    const min = cur.quantity * 2;
    return qty >= min ? { ok: true } : { ok: false, why: `Need ≥ ${min} to leave 1s` };
  }
  if (qty > cur.quantity) return { ok: true };
  if (qty === cur.quantity && face > cur.face) return { ok: true };
  return { ok: false, why: 'Must be strictly higher (more qty, or same qty + higher face)' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen: Name
// ─────────────────────────────────────────────────────────────────────────────
const nameInput = document.getElementById('name-input');
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });
document.getElementById('name-submit').addEventListener('click', submitName);

function submitName() {
  const n = nameInput.value.trim();
  if (!n) { nameInput.focus(); return; }
  socket.emit('set_name', { name: n });
}

socket.on('name_set', ({ name }) => {
  myName = name;
  document.getElementById('menu-player-name').textContent = name;
  showScreen('screen-menu');
});

// ─────────────────────────────────────────────────────────────────────────────
// Screen: Menu
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => socket.emit('create_game'));

document.getElementById('btn-join-toggle').addEventListener('click', () => {
  const f = document.getElementById('join-form');
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) document.getElementById('room-code-input').focus();
});

document.getElementById('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitJoin();
  hideEl('join-error');
});

document.getElementById('btn-join-submit').addEventListener('click', submitJoin);

function submitJoin() {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_game', { roomCode: code });
}

socket.on('join_error', ({ message }) => {
  const el = document.getElementById('join-error');
  el.textContent = message;
  showEl(el);
});

// ─────────────────────────────────────────────────────────────────────────────
// Screen: Lobby
// ─────────────────────────────────────────────────────────────────────────────
socket.on('game_created', ({ roomCode, gameState }) => {
  myRoom = roomCode;
  gs = gameState;
  enterLobby(gameState);
});

socket.on('joined_game', ({ roomCode, gameState }) => {
  myRoom = roomCode;
  gs = gameState;
  enterLobby(gameState);
});

socket.on('lobby_update', state => {
  gs = state;
  renderLobby(state);
});

function enterLobby(state) {
  showScreen('screen-lobby');
  document.getElementById('lobby-code').textContent = state.code;
  renderLobby(state);
}

function renderLobby(state) {
  // Player list
  document.getElementById('lobby-players').innerHTML = state.players.map(p => {
    const isHost = p.id === state.host;
    const isMe   = p.id === myId;
    return `<div class="lobby-player${isHost ? ' is-host' : ''}">
      <span class="player-name">${esc(p.name)}</span>
      <div style="display:flex;gap:6px;align-items:center">
        ${isHost ? '<span class="host-chip">Host</span>' : ''}
        ${isMe   ? '<span class="you-chip">You</span>'  : ''}
      </div>
    </div>`;
  }).join('');

  // Start button
  const startBtn = document.getElementById('btn-start');
  const hint     = document.getElementById('start-hint');
  if (state.host === myId) {
    showEl(startBtn);
    if (state.players.length < 2) {
      startBtn.disabled = true;
      hint.textContent = 'Waiting for at least 2 players…';
    } else {
      startBtn.disabled = false;
      hint.textContent = `${state.players.length} player${state.players.length > 1 ? 's' : ''} ready — good to go!`;
    }
  } else {
    hideEl(startBtn);
    hint.textContent = 'Waiting for the host to start…';
  }
}

document.getElementById('btn-copy-code').addEventListener('click', () => {
  const code = document.getElementById('lobby-code').textContent;
  navigator.clipboard?.writeText(code).then(() => toast('Code copied!', 'ok')).catch(() => toast(code));
});

document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));

socket.on('start_error', ({ message }) => toast(message, 'error'));

// ─────────────────────────────────────────────────────────────────────────────
// Screen: Game — round start
// ─────────────────────────────────────────────────────────────────────────────
socket.on('round_start', state => {
  gs = state;
  hideEl('reveal-overlay');
  showScreen('screen-game');
  renderGame();
});

socket.on('your_dice', ({ dice }) => {
  myDice = dice;
  renderMyDice();
});

// ─────────────────────────────────────────────────────────────────────────────
// Game rendering
// ─────────────────────────────────────────────────────────────────────────────
function renderGame() {
  renderPlayersBar();
  renderBidDisplay();
  renderStatus();
  renderMyDice();
  renderActionUI();
}

function renderPlayersBar() {
  document.getElementById('players-bar').innerHTML = gs.players.map(p => {
    const active = p.id === gs.currentPlayerId;
    const me     = p.id === myId;
    const diceIcons = Array(p.diceCount).fill('◆').join(' ');
    return `<div class="player-chip${active ? ' is-active' : ''}${me ? ' is-me' : ''}${!p.connected ? ' disconnected' : ''}">
      <div class="chip-name" title="${esc(p.name)}">${esc(p.name)}${me ? ' ★' : ''}</div>
      <div class="chip-dice">${p.diceCount} 🎲</div>
      ${active ? '<div class="chip-turn">▶ turn</div>' : ''}
    </div>`;
  }).join('');

  document.getElementById('round-label').textContent = `Round ${gs.roundNumber}`;
  gs.isPalifico ? showEl('palifico-badge') : hideEl('palifico-badge');
}

function renderBidDisplay() {
  const valEl = document.getElementById('bid-display-value');
  const byEl  = document.getElementById('bid-display-by');
  if (gs.currentBid) {
    const { quantity, face } = gs.currentBid;
    valEl.textContent = `${quantity} × ${DICE[face]}`;
    valEl.classList.add('pop');
    valEl.addEventListener('animationend', () => valEl.classList.remove('pop'), { once: true });
  } else {
    valEl.textContent = '—';
  }
  byEl.textContent = gs.currentBid ? `bid in play` : 'no bid yet';
}

function renderStatus() {
  const bar = document.getElementById('status-bar');
  if (gs.currentPlayerId === myId) {
    bar.textContent = gs.firstBidOfRound ? 'Your turn — open the bidding!' : 'Your turn!';
    bar.className = 'my-turn';
  } else {
    bar.textContent = `${gs.currentPlayerName}'s turn…`;
    bar.className = 'waiting';
  }
  const total = gs.players.reduce((s, p) => s + p.diceCount, 0);
  document.getElementById('total-dice-note').textContent = ` (${total} dice in play)`;
}

function renderMyDice() {
  document.getElementById('my-dice').innerHTML =
    myDice.map(d => `<div class="die">${DICE[d]}</div>`).join('');
}

function renderActionUI() {
  const isMyTurn = gs.currentPlayerId === myId && gs.phase === 'playing';
  if (!isMyTurn) { hideEl('action-ui'); return; }

  showEl('action-ui');
  gs.isPalifico ? showEl('palifico-notice') : hideEl('palifico-notice');

  // Sensible default quantity for this bid
  if (gs.currentBid) {
    selQty  = gs.currentBid.quantity;
    selFace = gs.currentBid.face;
  } else {
    selQty  = 1;
    selFace = 2;
  }
  refreshBidControls();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bid controls
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('qty-down').addEventListener('click', () => { selQty = Math.max(1, selQty - 1); refreshBidControls(); });
document.getElementById('qty-up').addEventListener('click',   () => { selQty++; refreshBidControls(); });

document.querySelectorAll('.face-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    selFace = parseInt(btn.dataset.face, 10);
    refreshBidControls();
  });
});

function refreshBidControls() {
  document.getElementById('qty-val').textContent = selQty;

  // Face buttons
  document.querySelectorAll('.face-btn').forEach(btn => {
    const f = parseInt(btn.dataset.face, 10);
    btn.classList.toggle('selected', f === selFace);

    if (gs.isPalifico && gs.palificoFace !== null) {
      btn.disabled = (f !== gs.palificoFace);
    } else if (gs.firstBidOfRound) {
      btn.disabled = (f === 1);   // can't open with 1s
    } else {
      btn.disabled = false;
    }
  });

  // Validate
  const v = clientValidate(gs, selQty, selFace);
  document.getElementById('bid-hint-msg').textContent = v.ok ? '' : v.why;
  document.getElementById('btn-bid').disabled = !v.ok;

  // Challenge
  document.getElementById('btn-challenge').disabled = gs.firstBidOfRound;
}

document.getElementById('btn-bid').addEventListener('click', () => {
  socket.emit('make_bid', { quantity: selQty, face: selFace });
});

document.getElementById('btn-challenge').addEventListener('click', () => {
  socket.emit('challenge');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bid made (someone else bid)
// ─────────────────────────────────────────────────────────────────────────────
socket.on('bid_made', ({ bid, bidderName, gameState: state }) => {
  gs = state;
  renderGame();
  if (bidderName !== myName) {
    toast(`${bidderName} bid ${bid.quantity} × ${DICE[bid.face]}`);
  }
});

socket.on('bid_error', ({ message }) => toast(message, 'error'));

// ─────────────────────────────────────────────────────────────────────────────
// Challenge reveal
// ─────────────────────────────────────────────────────────────────────────────
socket.on('challenge_result', result => {
  hideEl('action-ui');
  showReveal(result);
});

function showReveal(r) {
  const { revealedDice, bid, count, bidMet, isPalifico, bidderName, challengerName, loserName } = r;

  // All dice
  document.getElementById('reveal-all-dice').innerHTML = revealedDice.map(pd => {
    const isMe = pd.id === myId;
    const diceHtml = pd.dice.map(d => {
      const wild = !isPalifico && d === 1 && bid.face !== 1;
      const match = d === bid.face;
      return `<div class="die small${(wild || match) ? ' highlighted' : ''}">${DICE[d]}</div>`;
    }).join('');
    return `<div class="reveal-player-block">
      <div class="reveal-player-label">${esc(pd.name)}${isMe ? ' (you)' : ''}</div>
      <div class="reveal-dice-row">${diceHtml}</div>
    </div>`;
  }).join('');

  // Summary
  const wildNote = isPalifico ? ' (no wilds — Palifico)' : ` (1s are wild)`;
  document.getElementById('reveal-summary').innerHTML = `
    <div class="reveal-summary-bid">Bid: ${bid.quantity} × ${DICE[bid.face]}</div>
    <div class="reveal-summary-count">Found: <strong>${count}</strong> ${DICE[bid.face]}${wildNote}</div>
    <div class="reveal-outcome ${bidMet ? 'win' : 'lose'}">
      ${bidMet
        ? `✓ Bid correct! <strong>${esc(challengerName)}</strong> loses a die.`
        : `✗ Bid wrong! <strong>${esc(bidderName)}</strong> loses a die.`}
    </div>
    <div class="reveal-loser-line">💀 ${esc(loserName)} loses a die</div>`;

  showEl('reveal-overlay');
}

// ─────────────────────────────────────────────────────────────────────────────
// Player eliminated
// ─────────────────────────────────────────────────────────────────────────────
socket.on('player_eliminated', ({ playerName }) => {
  animateElimination(playerName);
});

function animateElimination(name) {
  document.getElementById('elimination-name').textContent = `${name} eliminated!`;

  const container = document.getElementById('dice-particles');
  container.innerHTML = '';

  for (let i = 0; i < 22; i++) {
    const p   = document.createElement('div');
    p.className = 'dice-particle';
    p.textContent = DICE[Math.floor(Math.random() * 6) + 1];

    const angle    = Math.random() * Math.PI * 2;
    const dist     = 90 + Math.random() * 220;
    const ex       = Math.cos(angle) * dist;
    const ey       = Math.sin(angle) * dist;
    const dur      = (.7 + Math.random() * .8).toFixed(2);
    const delay    = (Math.random() * .35).toFixed(2);

    p.style.setProperty('--ex',    `${ex}px`);
    p.style.setProperty('--ey',    `${ey}px`);
    p.style.setProperty('--dur',   `${dur}s`);
    p.style.setProperty('--delay', `${delay}s`);

    container.appendChild(p);
  }

  showEl('elimination-overlay');
  setTimeout(() => hideEl('elimination-overlay'), 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Game over
// ─────────────────────────────────────────────────────────────────────────────
socket.on('game_over', ({ winner }) => {
  hideEl('reveal-overlay');
  document.getElementById('winner-name').textContent = winner;
  setTimeout(() => showScreen('screen-over'), 500);
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  gs = null; myDice = []; myRoom = null;
  showScreen('screen-menu');
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc events
// ─────────────────────────────────────────────────────────────────────────────
socket.on('player_disconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} disconnected`, 'warn');
  if (gs && gs.phase === 'playing') renderGame();
});

socket.on('disconnect', () => toast('Disconnected from server…', 'error'));
socket.on('reconnect',  () => toast('Reconnected!', 'ok'));
