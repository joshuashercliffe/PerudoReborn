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

fetch('/version').then(r => r.json()).then(({ build, deployedAt }) => {
  const d    = new Date(deployedAt);
  const date = d.toISOString().slice(0, 10);
  const el   = document.getElementById('build-info');
  el.textContent = `build ${build} · ${date}`;
  el.title = d.toLocaleString();
}).catch(() => {});

socket1.on('server_stats', ({ games, players }) => {
  const statsEl = document.getElementById('server-stats');
  if (!statsEl) return;
  if (games === 0) { statsEl.textContent = ''; return; }
  statsEl.textContent = `${games} active game${games !== 1 ? 's' : ''} · ${players} player${players !== 1 ? 's' : ''}`;
});

// ─── Per-player state ─────────────────────────────────────────────────────────
// PS[0] = primary player; extra test players are pushed as PS[1], PS[2], …
const PS = [
  { socket: socket1, id: null, name: null, dice: [], autoLiar: false, lockedBid: null },
];
let activeIdx     = 0;   // which player the UI is currently controlling
let dualMode      = false;
let testMode      = false;

// Shared game state
let gs             = null;
let selQty         = 1;
let selFace        = 2;
let lbQty          = 1;
let lbFace         = 2;
let bidHistory     = [];
let showBidHistory = localStorage.getItem('showBidHistory') === 'true';
let hideDice       = false;
let diceRevealed   = false;
let dealGeneration = 0;
let ipLiarQty = 1, ipLiarFace = 2, ipLiarAccused = null;
let ipConfQty = 1, ipConfFace = 2, ipConfirmSocket = null;
let ipChallengePending = false;
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
const landingNameInput = document.getElementById('landing-name-input');
const roomCodeInput    = document.getElementById('room-code-input');
const btnLandingAction = document.getElementById('btn-landing-action');

function getLandingName() { return landingNameInput.value.trim(); }

function landingError(msg) {
  const el = document.getElementById('landing-error');
  el.textContent = msg;
  showEl('landing-error');
}

roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
  btnLandingAction.textContent = roomCodeInput.value.trim() ? 'Join Game' : 'Create Game';
});

btnLandingAction.addEventListener('click', () => {
  if (!getLandingName()) { landingNameInput.focus(); return; }
  hideEl('landing-error');
  const code = roomCodeInput.value.trim().toUpperCase();
  if (code === 'TEST') {
    testMode = true;
    socket1.emit('create_room');
  } else if (code) {
    socket1.emit('join_game', { roomId: code });
  } else {
    socket1.emit('create_room');
  }
});

landingNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnLandingAction.click(); });
roomCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnLandingAction.click(); });

function submitJoinGame() {
  if (!getLandingName()) { landingNameInput.focus(); return; }
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!code) { roomCodeInput.focus(); return; }
  hideEl('landing-error');
  socket1.emit('join_game', { roomId: code });
}

socket1.on('room_created', ({ roomId }) => {
  currentRoomId = roomId;
  socket1.emit('set_name', { name: getLandingName() });
});

socket1.on('join_game_ok', ({ roomId }) => {
  currentRoomId = roomId;
  hideEl('landing-error');
  socket1.emit('set_name', { name: getLandingName() });
});

socket1.on('join_error', ({ message }) => {
  showScreen('screen-landing');
  landingError(message);
});

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

  if (testMode && !dualMode) {
    showEl('p2-setup');
    testMode = false;
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
    if (gs?.isInPerson && PS[0].dice.length > 0) dealMyDice();
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
  document.getElementById('lobby-players').innerHTML = state.players.map((pl, idx) => {
    const isHost  = pl.id === state.host;
    const isMe    = pl.id === pid();
    const canKick = iAmLobbyHost && !pl.connected && !isMe && !dualMode;
    return `<div class="lobby-player${isHost ? ' is-host' : ''}${!pl.connected ? ' disconnected' : ''}"
               data-id="${esc(pl.id)}" data-idx="${idx}" ${iAmLobbyHost ? 'draggable="true"' : ''}>
      ${iAmLobbyHost ? '<span class="drag-handle">⠿</span>' : ''}
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
    btn.disabled = !iAmLobbyHost;
  });
  document.getElementById('mode-desc').textContent = modeDescs[state.gameMode] ?? '';

  const varBtn = document.getElementById('btn-variable');
  varBtn.dataset.active = state.isVariable ? 'true' : 'false';
  varBtn.classList.toggle('active', !!state.isVariable);
  varBtn.disabled = !iAmLobbyHost;

  const ipBtn = document.getElementById('btn-inperson');
  ipBtn.dataset.active = state.isInPerson ? 'true' : 'false';
  ipBtn.classList.toggle('active', !!state.isInPerson);
  ipBtn.disabled = !iAmLobbyHost;

  iAmLobbyHost ? hideEl('host-only-hint') : showEl('host-only-hint');

  const startBtn = document.getElementById('btn-start');
  const hint     = document.getElementById('start-hint');
  if (iAmLobbyHost) {
    showEl(startBtn);
    if (state.players.length < 2) {
      startBtn.disabled = true;
      hint.textContent = 'Waiting for at least 2 players…';
    } else {
      startBtn.disabled = false;
      hint.textContent = `${state.players.length} players ready`;
    }
  } else {
    hideEl(startBtn);
    hint.textContent = 'Waiting for the host to start…';
  }
}

document.getElementById('btn-start').addEventListener('click', () => p().socket.emit('start_game'));
document.getElementById('btn-leave-lobby').addEventListener('click', () => p().socket.emit('leave_lobby'));
document.getElementById('lobby-players').addEventListener('click', e => {
  const btn = e.target.closest('.btn-kick');
  if (btn) {
    const pl = gs?.players.find(p => p.id === btn.dataset.id);
    if (!confirm(`Kick ${pl ? pl.name : 'this player'}?`)) return;
    p().socket.emit('kick_player', { playerId: btn.dataset.id });
  }
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

document.getElementById('btn-inperson').addEventListener('click', function() {
  const newVal = this.dataset.active !== 'true';
  p().socket.emit('set_inperson', { value: newVal });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lobby drag-to-reorder seating
// ─────────────────────────────────────────────────────────────────────────────
let dragSrcIdx = null;
const lobbyList = document.getElementById('lobby-players');

lobbyList.addEventListener('dragstart', e => {
  const row = e.target.closest('[data-idx]');
  if (!row) return;
  dragSrcIdx = parseInt(row.dataset.idx, 10);
  e.dataTransfer.effectAllowed = 'move';
});

lobbyList.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.target.closest('[data-idx]');
  lobbyList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  if (row) row.classList.add('drag-over');
});

lobbyList.addEventListener('dragleave', e => {
  if (!lobbyList.contains(e.relatedTarget)) {
    lobbyList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }
});

lobbyList.addEventListener('drop', e => {
  e.preventDefault();
  lobbyList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  const row = e.target.closest('[data-idx]');
  if (!row || dragSrcIdx === null) { dragSrcIdx = null; return; }
  const destIdx = parseInt(row.dataset.idx, 10);
  if (dragSrcIdx === destIdx) { dragSrcIdx = null; return; }
  const ids = gs.players.map(pl => pl.id);
  const [moved] = ids.splice(dragSrcIdx, 1);
  ids.splice(destIdx, 0, moved);
  dragSrcIdx = null;
  p().socket.emit('reorder_players', { order: ids });
});

lobbyList.addEventListener('dragend', () => {
  dragSrcIdx = null;
  lobbyList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-player test mode: add players + toggle
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('btn-add-p2').addEventListener('click', () => {
  const input = document.getElementById('p2-name-input');
  const name  = input.value.trim() || `Player ${PS.length + 1}`;
  initTestPlayer(name);
  input.value = '';
  input.placeholder = `Player ${PS.length + 1} name`;
  input.focus();
});
document.getElementById('p2-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-add-p2').click();
});


function initTestPlayer(name) {
  const idx    = PS.length;
  const socket = io();
  PS.push({ socket, id: null, name: null, dice: [], autoLiar: false, lockedBid: null });

  if (!dualMode) {
    dualMode = true;
    document.body.classList.add('dual-mode');
  }
  updateToggleLabels();

  socket.on('connect', () => {
    PS[idx].id = socket.id;
    socket.emit('join_game', { roomId: currentRoomId });
  });

  socket.on('join_game_ok', () => {
    socket.emit('set_name', { name });
  });

  socket.on('join_error', ({ message }) => {
    toast(`P${idx + 1}: ${message}`, 'error');
  });

  socket.on('joined_lobby', state => {
    PS[idx].id   = socket.id;
    PS[idx].name = state.players.find(pl => pl.id === socket.id)?.name ?? name;
    gs = state;
    updateToggleLabels();
    renderLobby(state);
  });

  socket.on('your_dice', ({ dice }) => {
    PS[idx].dice = dice;
    if (activeIdx === idx) { dealMyDice(); applyDicePrivacy(); }
  });

  socket.on('ip_confirm_request', data => showIPConfirmOverlay(data, socket));

  socket.on('ip_challenge_pending', ({ challengerName, accusedName }) => {
    ipChallengePending = true;
    if (activeIdx === idx) renderGame();
    toast(`${challengerName} is calling liar on ${accusedName}'s bid…`, 'warn');
  });

  socket.on('ip_challenge_cancelled', () => {
    ipChallengePending = false;
    hideEl('ip-confirm-overlay');
    if (activeIdx === idx) renderGame();
  });
}

function updateToggleLabels() {
  if (gs) renderPlayersBar();
}

function switchPlayer(idx) {
  if (!PS[idx]) return;
  activeIdx = idx;
  hideEl('ip-confirm-overlay');
  hideEl('ip-liar-overlay');
  updateToggleLabels();
  if (document.getElementById('screen-lobby').classList.contains('active') && gs) {
    renderLobby(gs);
  } else if (gs && (gs.phase === 'playing' || gs.phase === 'reveal')) {
    renderGame();
    if (pdice().length > 0) dealMyDice();
    applyDicePrivacy();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Game menu
// ─────────────────────────────────────────────────────────────────────────────
(function initGameMenu() {
  const menuBtn    = document.getElementById('game-menu-btn');
  const menuPanel  = document.getElementById('game-menu-panel');
  const histCheck  = document.getElementById('toggle-bid-history');
  const diceCheck  = document.getElementById('toggle-hide-dice');

  histCheck.checked = showBidHistory;
  diceCheck.checked = hideDice;

  menuBtn.addEventListener('click', e => {
    e.stopPropagation();
    menuPanel.classList.toggle('hidden');
  });

  document.addEventListener('click', () => menuPanel.classList.add('hidden'));
  menuPanel.addEventListener('click', e => e.stopPropagation());

  histCheck.addEventListener('change', () => {
    showBidHistory = histCheck.checked;
    localStorage.setItem('showBidHistory', showBidHistory);
    updateBidHistoryVisibility();
    if (showBidHistory) renderBidHistory();
  });

  diceCheck.addEventListener('change', () => {
    hideDice = diceCheck.checked;
    if (!hideDice) diceRevealed = false;
    applyDicePrivacy();
  });
})();

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

function applyDicePrivacy() {
  const cover = document.getElementById('dice-privacy-cover');
  const diceEl = document.getElementById('my-dice');
  const effectiveHide = hideDice || (gs?.isInPerson && gs?.phase === 'playing');
  if (!effectiveHide) {
    cover.classList.add('hidden');
    diceEl.classList.remove('dice-obscured');
    return;
  }
  const hint = document.getElementById('dice-reveal-hint');
  hint.textContent = 'Hold to reveal your dice';
  cover.classList.remove('hidden');
  diceRevealed ? diceEl.classList.remove('dice-obscured') : diceEl.classList.add('dice-obscured');
}

(function initDicePrivacyCover() {
  const cover = document.getElementById('dice-privacy-cover');

  const startReveal = e => {
    const effectiveHide = hideDice || (gs?.isInPerson && gs?.phase === 'playing');
    if (!effectiveHide) return;
    e.preventDefault();
    diceRevealed = true;
    applyDicePrivacy();
  };

  cover.addEventListener('pointerdown', startReveal);
  // touchstart fallback: fires before pointerdown on some browsers when
  // contact shape is irregular (e.g. side of hand), needs passive:false
  cover.addEventListener('touchstart', startReveal, { passive: false });

  const endReveal = () => {
    if (!diceRevealed) return;
    diceRevealed = false;
    applyDicePrivacy();
  };

  document.addEventListener('pointerup',     endReveal);
  document.addEventListener('pointercancel', endReveal);
  document.addEventListener('touchend',      endReveal);
})();

function updateBidHistoryVisibility() {
  showBidHistory ? showEl('bid-history-inline') : hideEl('bid-history-inline');
}

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

(function initLbFacePicker() {
  const picker = document.getElementById('lb-face-picker');
  picker.innerHTML = [1,2,3,4,5,6].map(f =>
    `<button class="face-btn" data-face="${f}">${makeDie(f)}</button>`
  ).join('');
  picker.addEventListener('click', e => {
    const btn = e.target.closest('.face-btn');
    if (!btn || btn.disabled) return;
    lbFace = parseInt(btn.dataset.face, 10);
    refreshLockBidControls();
  });
})();

function refreshLockBidControls() {
  document.getElementById('lb-qty-val').textContent = lbQty;
  if (gs && !gs.isFaceoff) {
    document.querySelectorAll('#lb-face-picker .face-btn').forEach(btn => {
      const f = parseInt(btn.dataset.face, 10);
      btn.classList.toggle('selected', f === lbFace);
      btn.disabled = !!(gs.isPalifico && gs.palificoFace !== null && pdice().length > 1 && f !== gs.palificoFace);
    });
  }
  const v = gs ? clientValidate(gs, lbQty, gs.isFaceoff ? 0 : lbFace) : { ok: false, why: '' };
  document.getElementById('lb-hint-msg').textContent = v.ok ? '' : v.why;
  document.getElementById('btn-confirm-lock-bid').disabled = !v.ok;
}

function renderLockBidSection() {
  if (!gs || gs.isInPerson || gs.phase !== 'playing' || gs.currentPlayerId === pid()) {
    hideEl('lockbid-section');
    hideEl('lockbid-controls-panel');
    return;
  }
  showEl('lockbid-section');
  const locked = p()?.lockedBid;
  if (locked) {
    hideEl('lockbid-btn-area');
    hideEl('lockbid-controls-panel');
    showEl('lockbid-locked');
    const label = locked.face
      ? `🔒 ${locked.quantity} × ${makeDie(locked.face, 'tiny')}`
      : `🔒 Sum: ${locked.quantity}`;
    document.getElementById('lockbid-locked-label').innerHTML = label;
  } else {
    showEl('lockbid-btn-area');
    hideEl('lockbid-locked');
  }
}

document.getElementById('lb-qty-down').addEventListener('click', () => { lbQty = Math.max(1, lbQty - 1); refreshLockBidControls(); });
document.getElementById('lb-qty-up').addEventListener('click',   () => { lbQty = gs?.isFaceoff ? Math.min(12, lbQty + 1) : lbQty + 1; refreshLockBidControls(); });

document.getElementById('btn-lock-bid').addEventListener('click', () => {
  if (!gs) return;
  gs.isFaceoff ? hideEl('lb-face-picker') : showEl('lb-face-picker');
  refreshLockBidControls();
  showEl('lockbid-controls-panel');
});

document.getElementById('btn-confirm-lock-bid').addEventListener('click', () => {
  if (!gs) return;
  const face = gs.isFaceoff ? null : lbFace;
  const v = clientValidate(gs, lbQty, gs.isFaceoff ? 0 : lbFace);
  if (!v.ok) return;
  p().lockedBid = { quantity: lbQty, face };
  p().socket.emit('lock_autobid');
  renderLockBidSection();
  const label = face ? `Autobid: ${lbQty} × ${FACE_NAME[face]}` : `Autobid: sum ${lbQty}`;
  showLockFlyby(label);
});

function fireAutobidWithDelay(ps, lb) {
  const faceArg = gs.isFaceoff ? 0 : (lb.face ?? 0);
  const v = clientValidate(gs, lb.quantity, faceArg);
  if (!v.ok) {
    toast('Locked autobid no longer valid — bid manually', 'warn');
    renderLockBidSection();
    renderPlayersBar();
    return;
  }

  const overlay = document.getElementById('autobid-fire-overlay');
  const bidEl   = document.getElementById('autobid-fire-bid');
  const fill    = document.getElementById('autobid-fire-fill');

  bidEl.innerHTML = lb.face
    ? `${lb.quantity} × ${makeDie(lb.face, 'small')}`
    : `Sum: ${lb.quantity}`;

  fill.classList.remove('running');
  void fill.offsetWidth;
  showEl(overlay);
  fill.classList.add('running');

  setTimeout(() => {
    hideEl(overlay);
    ps.socket.emit('make_bid', { quantity: lb.quantity, face: faceArg });
    const label = lb.face ? `${lb.quantity} ${FACE_NAME[lb.face]}` : `sum ${lb.quantity}`;
    toast(`Auto-bid: ${label}`, 'ok');
    renderLockBidSection();
    renderPlayersBar();
  }, 1600);
}

let flybyTimer = null;
function showLockFlyby(text) {
  const el   = document.getElementById('lock-flyby');
  const icon = document.getElementById('lock-flyby-icon');
  const lbl  = document.getElementById('lock-flyby-text');
  if (flybyTimer) { clearTimeout(flybyTimer); flybyTimer = null; }
  icon.textContent = '🔓';
  lbl.textContent  = text;
  el.classList.remove('hidden', 'flyby-run');
  void el.offsetWidth;
  el.classList.add('flyby-run');
  flybyTimer = setTimeout(() => { icon.textContent = '🔒'; }, 600);
  setTimeout(() => { el.classList.add('hidden'); el.classList.remove('flyby-run'); }, 3200);
}

// ─────────────────────────────────────────────────────────────────────────────
// In-person mode
// ─────────────────────────────────────────────────────────────────────────────
function ipFacePicker(containerId, getVal, setVal) {
  const el = document.getElementById(containerId);
  el.innerHTML = [1,2,3,4,5,6].map(f => `<button class="face-btn" data-face="${f}">${makeDie(f)}</button>`).join('');
  el.addEventListener('click', e => {
    const b = e.target.closest('.face-btn'); if (!b) return;
    setVal(parseInt(b.dataset.face, 10));
    el.querySelectorAll('.face-btn').forEach(btn => btn.classList.toggle('selected', parseInt(btn.dataset.face,10) === getVal()));
  });
}

(function initInPersonMode() {
  ipFacePicker('ip-face-picker', () => ipLiarFace, v => { ipLiarFace = v; });

  // Liar modal: qty
  document.getElementById('ip-qty-down').addEventListener('click', () => {
    ipLiarQty = Math.max(1, ipLiarQty - 1);
    document.getElementById('ip-qty-val').textContent = ipLiarQty;
  });
  document.getElementById('ip-qty-up').addEventListener('click', () => {
    ipLiarQty++;
    document.getElementById('ip-qty-val').textContent = ipLiarQty;
  });

  // Liar modal: accused player selection
  document.getElementById('ip-accused-list').addEventListener('click', e => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    ipLiarAccused = b.dataset.id;
    document.querySelectorAll('#ip-accused-list [data-id]').forEach(btn =>
      btn.classList.toggle('selected', btn.dataset.id === ipLiarAccused));
    document.getElementById('btn-ip-submit').disabled = false;
  });

  document.getElementById('btn-ip-cancel').addEventListener('click', () => hideEl('ip-liar-overlay'));

  document.getElementById('btn-ip-submit').addEventListener('click', () => {
    if (!ipLiarAccused) return;
    p().socket.emit('ip_challenge', { qty: ipLiarQty, face: ipLiarFace, accusedId: ipLiarAccused });
    hideEl('ip-liar-overlay');
  });

  document.getElementById('btn-ip-conf-cancel').addEventListener('click', () => {
    (ipConfirmSocket || p().socket).emit('ip_cancel');
    ipConfirmSocket = null;
    hideEl('ip-confirm-overlay');
  });

  document.getElementById('btn-ip-conf-confirm').addEventListener('click', () => {
    (ipConfirmSocket || p().socket).emit('ip_confirm', { qty: ipConfQty, face: ipConfFace });
    ipConfirmSocket = null;
    hideEl('ip-confirm-overlay');
  });

  // Call Liar button: open the liar modal
  document.getElementById('btn-ip-liar').addEventListener('click', () => {
    if (!gs || ipChallengePending) return;

    // Default qty: 1 above quick maths
    const total = gs.players.reduce((s, pl) => s + pl.diceCount, 0);
    ipLiarQty = Math.floor(total / 3) + 1;
    ipLiarFace = 2;

    // Default accused: player immediately before caller in turn order
    const activePlayers = gs.players.filter(pl => pl.diceCount > 0);
    const callerIdx = activePlayers.findIndex(pl => pl.id === pid());
    const prevPlayer = activePlayers[(callerIdx - 1 + activePlayers.length) % activePlayers.length];
    ipLiarAccused = (prevPlayer && prevPlayer.id !== pid()) ? prevPlayer.id : null;

    document.getElementById('ip-qty-val').textContent = ipLiarQty;
    gs.isFaceoff ? hideEl('ip-face-group') : showEl('ip-face-group');
    document.querySelectorAll('#ip-face-picker .face-btn').forEach(btn =>
      btn.classList.toggle('selected', parseInt(btn.dataset.face, 10) === ipLiarFace));
    document.getElementById('ip-accused-list').innerHTML = gs.players
      .filter(pl => pl.id !== pid())
      .map(pl => `<button class="ip-accused-btn" data-id="${esc(pl.id)}">${esc(pl.name)}</button>`)
      .join('');
    document.querySelectorAll('#ip-accused-list [data-id]').forEach(btn =>
      btn.classList.toggle('selected', btn.dataset.id === ipLiarAccused));
    document.getElementById('btn-ip-submit').disabled = !ipLiarAccused;
    showEl('ip-liar-overlay');
  });
})();

// In-person server events
function showIPConfirmOverlay({ challengerName, qty, face }, socket) {
  ipConfQty      = qty;
  ipConfFace     = face ?? 2;
  ipConfirmSocket = socket ?? null;
  document.getElementById('ip-confirm-title').textContent = `${challengerName} called Liar on your bid`;
  document.getElementById('ip-conf-qty-val').textContent  = ipConfQty;
  const isFaceoff = face === null;
  isFaceoff ? hideEl('ip-conf-face-group') : showEl('ip-conf-face-group');
  if (!isFaceoff) {
    document.getElementById('ip-conf-face-display').innerHTML = makeDie(ipConfFace, 'small');
  }
  showEl('ip-confirm-overlay');
}

socket1.on('ip_confirm_request', data => showIPConfirmOverlay(data, socket1));

socket1.on('ip_challenge_pending', ({ challengerName, accusedName }) => {
  ipChallengePending = true;
  renderGame();
  toast(`${challengerName} is calling liar on ${accusedName}'s bid…`, 'warn');
});

socket1.on('ip_challenge_cancelled', () => {
  ipChallengePending = false;
  hideEl('ip-confirm-overlay');
  renderGame();
  toast('Challenge cancelled', '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Game — round start
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('round_start', state => {
  gs = state;
  PS[0].dice      = [];
  PS[0].autoLiar  = (state.autoLiarPlayerId === PS[0].id);
  PS[0].lockedBid = null;
  PS.slice(1).forEach(ps => { if (ps) { ps.dice = []; ps.autoLiar = (state.autoLiarPlayerId === ps.id); ps.lockedBid = null; } });
  lbQty = 1; lbFace = 2;
  diceRevealed = false;
  ipChallengePending = false;
  hideEl('ip-confirm-overlay');
  bidHistory = [];
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
  applyDicePrivacy();
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
  renderLockBidSection();
  renderReactionButtons();
}

function renderPlayersBar() {
  showEl('game-header');
  const myId    = pid();
  const iAmHost = myId === gs.host;
  // Rotate turn order so viewing player is leftmost
  const myIdx  = gs.players.findIndex(p => p.id === myId);
  const sorted = myIdx < 1
    ? gs.players
    : [...gs.players.slice(myIdx), ...gs.players.slice(0, myIdx)];
  const bar = document.getElementById('players-bar');
  bar.innerHTML = sorted.map(pl => {
    const active      = pl.id === gs.currentPlayerId;
    const me          = pl.id === myId;
    const canKick     = iAmHost && !pl.connected && !me && !dualMode;
    const dice        = pl.diceCount ? `${pl.diceCount}×🎲` : '—';
    const hasAutoliar = pl.id === gs.autoLiarPlayerId;
    const psLocal     = PS.find(ps => ps?.id === pl.id);
    const hasAutobid  = !!(psLocal?.lockedBid);
    const locks = (hasAutobid ? '<span class="chip-lock chip-lock-bid">AB</span>' : '')
                + (hasAutoliar ? '<span class="chip-lock chip-lock-liar">AL</span>' : '');
    return `<div class="player-chip${active ? ' is-active' : ''}${me ? ' is-me' : ''}${!pl.connected ? ' disconnected' : ''}" data-id="${esc(pl.id)}">
      <div class="chip-name" title="${esc(pl.name)}">${esc(pl.name)}${me ? ' ★' : ''}</div>
      <div class="chip-dice">${dice}${locks ? `<span class="chip-locks">${locks}</span>` : ''}</div>
      ${canKick ? `<button class="btn-kick" data-id="${esc(pl.id)}">Kick</button>` : ''}
    </div>`;
  }).join('');

  document.getElementById('round-label').textContent = `Round ${gs.roundNumber}`;
  gs.gameMode === 'reverse' ? showEl('mode-badge') : hideEl('mode-badge');
  gs.isPalifico && !gs.isFaceoff ? showEl('palifico-badge') : hideEl('palifico-badge');
  gs.isFaceoff ? showEl('faceoff-badge') : hideEl('faceoff-badge');
}

function renderBidDisplay() {
  if (gs.isInPerson) { hideEl('bid-display'); return; }
  showEl('bid-display');
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
    document.getElementById('qm-sub').textContent = '';
    document.getElementById('total-dice-note').textContent = '';
  } else {
    label.textContent = 'Quick Maths';
    const total = gs.players.reduce((s, pl) => s + pl.diceCount, 0);
    const qm = total / 3;
    const qm1s = total / 6;
    const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(1);
    document.getElementById('qm-value').textContent = fmt(qm);
    document.getElementById('qm-sub').textContent = `(${total} dice) · 1s: ${fmt(qm1s)}`;
    document.getElementById('total-dice-note').textContent = '';
  }
}

function renderStatus() {
  const bar = document.getElementById('status-bar');
  if (gs.isInPerson) { bar.textContent = ''; bar.className = ''; hideEl('status-bar'); return; }
  showEl('status-bar');
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
  if (gs?.isInPerson) { hideEl('bid-history-inline'); return; }
  updateBidHistoryVisibility();
  if (!showBidHistory) return;
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
      <span class="bhe-bid"><strong>${e.qty}</strong> × ${makeDie(e.face, 'tiny')}</span>
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
  const container = document.getElementById('my-dice');
  const wasCluster = container.classList.contains('ip-cluster');
  container.innerHTML = [...pdice()].sort((a, b) => a - b).map(d => make3DDie(d)).join('');
  if (wasCluster) {
    positionIPDice(container, [...container.querySelectorAll('.die3-wrap')]);
  }
}

function dealMyDice() {
  const gen = ++dealGeneration;
  const container = document.getElementById('my-dice');
  container.classList.remove('ip-cluster');
  container.style.width = container.style.height = '';
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
    if (gs?.isInPerson && gs?.phase === 'playing') {
      positionIPDice(container, wraps);
    } else {
      wraps.forEach((w, i) => {
        w.style.animationDelay = `${i * 90}ms`;
        w.classList.add('die3-landing');
      });
    }
  }));
}

function positionIPDice(container, wraps) {
  const N   = wraps.length;
  if (!N) return;
  const DIE  = window.innerWidth <= 560 ? 50 : 68;
  const RMAP = [0, 0, 42, 50, 56, 60];
  const R    = RMAP[N] ?? 64;
  const PAD  = 14;
  const SIZE = N <= 1 ? DIE + PAD * 2 : R * 2 + DIE + PAD * 2;
  const CX   = SIZE / 2;

  container.classList.add('ip-cluster');
  container.style.width  = SIZE + 'px';
  container.style.height = SIZE + 'px';

  wraps.forEach((w, i) => {
    const angle = N <= 1 ? 0
      : (i / N) * Math.PI * 2 - Math.PI / 2 + (Math.random() - 0.5) * 0.45;
    const r = R + (N > 1 ? (Math.random() - 0.5) * 16 : 0);
    const x = CX + (N <= 1 ? 0 : Math.cos(angle) * r) - DIE / 2;
    const y = CX + (N <= 1 ? 0 : Math.sin(angle) * r) - DIE / 2;
    const rot = (Math.random() - 0.5) * 24;
    w.style.position  = 'absolute';
    w.style.left      = x.toFixed(1) + 'px';
    w.style.top       = y.toFixed(1) + 'px';
    w.style.transform = `rotate(${rot.toFixed(1)}deg)`;
  });
}

function renderAutoLiarBtn() {
  if (gs.isInPerson) { hideEl('autoliar-section'); return; }
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
      btn.textContent = '🔒 Lock Autoliar';
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
  if (gs.isInPerson) {
    hideEl('action-ui');
    const active = gs.phase === 'playing' && !ipChallengePending;
    active ? showEl('ip-action-ui') : hideEl('ip-action-ui');
    document.getElementById('btn-ip-liar').disabled = ipChallengePending;
    return;
  }
  hideEl('ip-action-ui');
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
  const kickBtn = e.target.closest('.btn-kick');
  if (kickBtn) {
    const pl = gs?.players.find(p => p.id === kickBtn.dataset.id);
    if (!confirm(`Kick ${pl ? pl.name : 'this player'}?`)) return;
    p().socket.emit('kick_player', { playerId: kickBtn.dataset.id });
    return;
  }
  if (!dualMode) return;
  const chip = e.target.closest('.player-chip[data-id]');
  if (!chip) return;
  const psIdx = PS.findIndex(ps => ps?.id === chip.dataset.id);
  if (psIdx > -1) switchPlayer(psIdx);
});

document.getElementById('btn-autoliar').addEventListener('click', () => {
  if (!confirm('Lock in Autoliar? You will automatically call liar on the next bid.')) return;
  p().socket.emit('auto_liar');
  showLockFlyby('Autoliar Locked');
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
  PS.slice(1).forEach(ps => { if (ps) ps.autoLiar = (state.autoLiarPlayerId === ps.id); });
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

  // Auto-fire locked bid for any local player whose turn just arrived
  PS.forEach(ps => {
    if (!ps || ps.id !== gs.currentPlayerId || !ps.lockedBid) return;
    const lb = ps.lockedBid;
    ps.lockedBid = null;
    fireAutobidWithDelay(ps, lb);
  });
});

socket1.on('bid_error', ({ message }) => toast(message, 'error'));

// ─────────────────────────────────────────────────────────────────────────────
// LIAR called
// ─────────────────────────────────────────────────────────────────────────────
socket1.on('liar_called', ({ challengerName, isPeak }) => {
  ipChallengePending = false;
  hideEl('ip-confirm-overlay');
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
  // Start the next round in the background immediately so it's ready when dismissed.
  PS.filter(ps => ps?.socket).forEach(ps => ps.socket.emit('next_round'));
  document.getElementById('btn-next-round').textContent = 'Continue';
  showEl('btn-next-round');
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  hideEl('reveal-overlay');
  // next_round already sent on reveal_resolved; button just closes the overlay.
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
      const diceHtml = pd.dice.map(d => {
        const isMatch = d === bid.face || (!isPalifico && d === 1 && bid.face !== 1);
        return makeDie(d, `small${isMatch ? ' highlighted' : ' dim'}`);
      }).join('');
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

  document.getElementById('btn-next-round').textContent = 'Next Round →';
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
  PS.slice(1).forEach((ps, i) => { if (ps?.id === playerId) { ps.dice = []; if (activeIdx === i + 1) renderReactionButtons(); } });
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
  PS.slice(1).forEach((ps, i) => { if (ps?.id === playerId) { ps.autoLiar = true; if (activeIdx === i + 1) renderAutoLiarBtn(); } });
  showAutoLiarOverlay(playerName);
});

socket1.on('autobid_update', ({ playerId, playerName }) => {
  renderPlayersBar();
  // Locker already saw the flyby from their own click — only show for others
  const isMe = PS.some(ps => ps?.id === playerId);
  if (!isMe) showLockFlyby(`${playerName}: Autobid Locked`);
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
  PS.slice(1).forEach(ps => { if (ps) ps.autoLiar = false; });
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
    PS.slice(1).forEach(ps => ps?.socket.disconnect());
    PS.length  = 1;
    dualMode   = false;
    activeIdx  = 0;
    document.body.classList.remove('dual-mode');
  }

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
