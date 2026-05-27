'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
const socket = io();

// Dot layout for each die face (3×3 grid, 1=dot, 0=empty)
const DIE_LAYOUT = {
  1: [0,0,0, 0,1,0, 0,0,0],
  2: [0,0,1, 0,0,0, 1,0,0],
  3: [0,0,1, 0,1,0, 1,0,0],
  4: [1,0,1, 0,0,0, 1,0,1],
  5: [1,0,1, 0,1,0, 1,0,1],
  6: [1,0,1, 1,0,1, 1,0,1],
};

// Text name for toast messages
const FACE_NAME = ['', '1s', '2s', '3s', '4s', '5s', '6s'];

function makeDie(value, extraClass = '') {
  const layout = DIE_LAYOUT[value] || DIE_LAYOUT[1];
  const dots = layout.map(on => `<span class="dot${on ? '' : ' empty'}"></span>`).join('');
  return `<div class="die${extraClass ? ' ' + extraClass : ''}">${dots}</div>`;
}

// Client state
let myId        = null;
let myName      = null;
let gs          = null;
let myDice      = [];
let selQty      = 1;
let selFace     = 2;
let bidHistory  = [];

socket.on('connect', () => {
  myId = socket.id;
  // Attempt to rejoin an existing session (handles refresh, screen lock, network drop)
  const token = localStorage.getItem('perudoSession');
  if (token) socket.emit('rejoin', { sessionToken: token });
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
  if (!Number.isInteger(face) || face < 1 || face > 6) return { ok: false, why: 'Invalid face' };
  if (!Number.isInteger(qty)  || qty  < 1)             return { ok: false, why: 'Qty must be ≥ 1' };

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
  return { ok: false, why: 'Must be strictly higher' };
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
  hideEl('name-error');
  socket.emit('set_name', { name: n });
}

// Server rejected (game in progress)
socket.on('join_error', ({ message }) => {
  const el = document.getElementById('name-error');
  el.textContent = message;
  showEl(el);
});

// ─────────────────────────────────────────────────────────────────────────────
// Lobby
// ─────────────────────────────────────────────────────────────────────────────
socket.on('joined_lobby', state => {
  if (state.sessionToken) localStorage.setItem('perudoSession', state.sessionToken);
  myName = state.players.find(p => p.id === myId)?.name ?? null;
  gs = state;
  showScreen('screen-lobby');
  renderLobby(state);
});

// ── Rejoin handlers ───────────────────────────────────────────────────────────
socket.on('rejoined', ({ sessionToken, state, dice, phase }) => {
  localStorage.setItem('perudoSession', sessionToken);
  myId   = socket.id;
  gs     = state;
  myName = state.players.find(p => p.id === myId)?.name ?? null;
  myDice = dice || [];

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
    // playing or reveal — drop them back into the game view
    showScreen('screen-game');
    renderGame();
  }
  toast('Reconnected!', 'ok');
});

socket.on('rejoin_failed', () => {
  localStorage.removeItem('perudoSession');
  showScreen('screen-name');
});

socket.on('lobby_update', state => {
  gs = state;
  if (document.getElementById('screen-lobby').classList.contains('active') ||
      document.getElementById('screen-over').classList.contains('active')) {
    renderLobby(state);
  }
});

function renderLobby(state) {
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

  const startBtn = document.getElementById('btn-start');
  const hint     = document.getElementById('start-hint');
  const amInLobby = state.players.some(p => p.id === myId);
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

document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));
socket.on('start_error', ({ message }) => toast(message, 'error'));

// ─────────────────────────────────────────────────────────────────────────────
// Face picker — built with CSS dice
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
socket.on('round_start', state => {
  gs = state;
  bidHistory = [];
  hideEl('reveal-overlay');
  showScreen('screen-game');
  renderGame();
  renderBidHistory();
  if (state.isPalifico) showPalificoAnnounce(state.currentPlayerName);
});

function showPalificoAnnounce(triggerName) {
  const overlay = document.getElementById('palifico-overlay');
  document.getElementById('palifico-sub').textContent =
    `${triggerName} has one die — no wilds this round!`;

  // Re-trigger animations
  ['palifico-text', 'palifico-sub'].forEach(id => {
    const el = document.getElementById(id);
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });

  showEl(overlay);
  setTimeout(() => hideEl(overlay), 2000);
}

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
  renderQuickMaths();
  renderStatus();
  renderMyDice();
  renderActionUI();
}

function renderPlayersBar() {
  document.getElementById('players-bar').innerHTML = gs.players.map(p => {
    const active = p.id === gs.currentPlayerId;
    const me     = p.id === myId;
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
    valEl.innerHTML = `<span class="bid-qty">${quantity}</span><span class="bid-x">×</span>${makeDie(face, 'bid-die')}`;
    valEl.classList.add('pop');
    valEl.addEventListener('animationend', () => valEl.classList.remove('pop'), { once: true });
    byEl.textContent = 'bid in play';
  } else {
    valEl.innerHTML = '<span class="bid-qty empty">—</span>';
    byEl.textContent = 'no bid yet';
  }
}

function renderQuickMaths() {
  const total = gs.players.reduce((s, p) => s + p.diceCount, 0);
  const qm = total / 3;
  const display = Number.isInteger(qm) ? String(qm) : qm.toFixed(2);
  document.getElementById('qm-value').textContent = display;
  document.getElementById('total-dice-note').textContent = ` (${total} dice in play)`;
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
    return `<div class="bid-history-entry">
      <span class="bhe-name">${esc(e.name)}</span>
      <span class="bhe-arrow">→</span>
      <span class="bhe-bid"><strong>${e.qty}</strong> × ${makeDie(e.face, 'small')}</span>
    </div>`;
  }).join('');
  // Auto-scroll to bottom so latest bid is visible when open
  list.scrollTop = list.scrollHeight;
}

function renderMyDice() {
  document.getElementById('my-dice').innerHTML = [...myDice].sort((a, b) => a - b).map(d => makeDie(d)).join('');
}

function renderActionUI() {
  const isMyTurn = gs.currentPlayerId === myId && gs.phase === 'playing';
  if (!isMyTurn) { hideEl('action-ui'); return; }

  showEl('action-ui');
  gs.isPalifico ? showEl('palifico-notice') : hideEl('palifico-notice');

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

function refreshBidControls() {
  document.getElementById('qty-val').textContent = selQty;

  document.querySelectorAll('.face-btn').forEach(btn => {
    const f = parseInt(btn.dataset.face, 10);
    btn.classList.toggle('selected', f === selFace);

    if (gs.isPalifico && gs.palificoFace !== null) {
      btn.disabled = (f !== gs.palificoFace);
    } else if (gs.firstBidOfRound) {
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
  socket.emit('make_bid', { quantity: selQty, face: selFace });
});

document.getElementById('btn-challenge').addEventListener('click', () => {
  socket.emit('challenge');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bid made
// ─────────────────────────────────────────────────────────────────────────────
socket.on('bid_made', ({ bid, bidderName, gameState: state }) => {
  gs = state;
  bidHistory.push({ type: 'bid', name: bidderName, qty: bid.quantity, face: bid.face });
  renderGame();
  renderBidHistory();
  if (bidderName !== myName) {
    toast(`${bidderName} bid ${bid.quantity} ${FACE_NAME[bid.face]}`);
  }
});

socket.on('bid_error', ({ message }) => toast(message, 'error'));

// ─────────────────────────────────────────────────────────────────────────────
// LIAR called — show dramatic overlay for ~1.2s before reveal
// ─────────────────────────────────────────────────────────────────────────────
socket.on('liar_called', ({ challengerName }) => {
  bidHistory.push({ type: 'liar', name: challengerName });
  const overlay = document.getElementById('liar-overlay');
  document.getElementById('liar-caller').textContent = `${challengerName} called it!`;

  // Force re-trigger animation by replacing element
  const liarText = document.getElementById('liar-text');
  liarText.style.animation = 'none';
  void liarText.offsetWidth; // reflow
  liarText.style.animation = '';

  showEl(overlay);
  setTimeout(() => hideEl(overlay), 1200);
});

// ─────────────────────────────────────────────────────────────────────────────
// Challenge reveal
// ─────────────────────────────────────────────────────────────────────────────
socket.on('challenge_result', result => {
  hideEl('action-ui');
  showReveal(result);
});

function showReveal(r) {
  const { revealedDice, bid, count, bidMet, isPalifico, bidderName, challengerName, loserName } = r;

  document.getElementById('reveal-all-dice').innerHTML = revealedDice.map(pd => {
    const isMe = pd.id === myId;
    const relevant = pd.dice
      .filter(d => d === bid.face || (!isPalifico && d === 1 && bid.face !== 1))
      .sort((a, b) => a - b);
    const diceHtml = relevant.length
      ? relevant.map(d => makeDie(d, 'small highlighted')).join('')
      : '<span class="reveal-none">—</span>';
    return `<div class="reveal-player-block">
      <div class="reveal-player-label">${esc(pd.name)}${isMe ? ' (you)' : ''}</div>
      <div class="reveal-dice-row">${diceHtml}</div>
    </div>`;
  }).join('');

  const loserQuips = [
    `💀 ${esc(loserName)} angered the dice gods and paid the tax`,
    `💀 ${esc(loserName)} just lowered quick maths`,
    `💀 ${esc(loserName)} got audited by RNGesus`,
    `💀 ${esc(loserName)} experienced a critical skill issue`,
    `💀 ${esc(loserName)} is on his way straight home`,
    `💀 ${esc(loserName)} lost a die to budget cuts`,
  ];
  const loserLine = loserQuips[Math.floor(Math.random() * loserQuips.length)];

  document.getElementById('reveal-summary').innerHTML = `
    <div class="reveal-summary-bid">Bid: ${bid.quantity} × ${makeDie(bid.face, 'small')}</div>
    <div class="reveal-summary-count">Found: <strong>${count}</strong> ${FACE_NAME[bid.face]}</div>
    <div class="reveal-outcome ${bidMet ? 'win' : 'lose'}">
      ${bidMet
        ? `✓ Bid correct! <strong>${esc(challengerName)}</strong> loses a die`
        : `✗ Bid wrong! <strong>${esc(bidderName)}</strong> loses a die`}
    </div>
    <div class="reveal-loser-line">${loserLine}</div>`;

  showEl('reveal-overlay');
}

// ─────────────────────────────────────────────────────────────────────────────
// Elimination
// ─────────────────────────────────────────────────────────────────────────────
socket.on('player_eliminated', ({ playerName }) => {
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
socket.on('game_over', ({ winner }) => {
  hideEl('reveal-overlay');
  const victoryQuips = [
    `👑 ${winner} has conquered the table and claimed victory`,
    `🎲 ${winner} has become statistically unstoppable`,
    `🔥 ${winner} turned pure luck into total domination`,
  ];
  document.getElementById('winner-name').textContent =
    victoryQuips[Math.floor(Math.random() * victoryQuips.length)];
  setTimeout(() => showScreen('screen-over'), 600);
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  socket.emit('return_to_lobby');
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
  socket.emit('rage_quit');
});

socket.on('lobby_update', state => {
  gs = state;
  if (document.getElementById('screen-over').classList.contains('active')) {
    showScreen('screen-lobby');
    renderLobby(state);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────
socket.on('player_disconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} disconnected — waiting 60s`, 'warn');
  if (gs?.phase === 'playing') renderGame();
});

socket.on('player_reconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} reconnected`, 'ok');
  if (gs?.phase === 'playing') renderGame();
});

socket.on('disconnect', () => toast('Connection lost — reconnecting…', 'warn'));
