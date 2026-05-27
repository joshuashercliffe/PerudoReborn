'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
const socket = io();

// Player colours — index matches server-assigned colorIndex
const PLAYER_COLORS = ['#60a5fa','#f87171','#4ade80','#d97706','#c084fc','#fb923c','#2dd4bf','#f472b6'];

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

// 3D die: cube rotation to show each face value to the viewer
// Face positions in cube: f1=front, f2=right, f3=top, f4=bottom, f5=left, f6=back
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

// Client state
let myId          = null;
let myName        = null;
let gs            = null;
let myDice        = [];
let selQty        = 1;
let selFace       = 2;
let bidHistory    = [];
let dealGeneration = 0;

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
    if (myDice.length === 1) {
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

// Server rejected (game in progress) — show the in-session card
socket.on('join_error', () => {
  hideEl('name-card');
  showEl('in-session-card');
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
    if (phase === 'playing') hideEl('reveal-overlay');
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
  if (document.getElementById('screen-lobby').classList.contains('active')) {
    renderLobby(state);
  } else if (document.getElementById('screen-over').classList.contains('active')) {
    if (state.players.some(p => p.id === myId)) {
      showScreen('screen-lobby');
      renderLobby(state);
    } else {
      localStorage.removeItem('perudoSession');
      showScreen('screen-name');
    }
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

  // Sync mode picker
  const modeDescs = {
    standard: '5 dice each — lose a die when you lose a round',
    reverse:  '1 die each — gain a die when you lose, go above 5 and you\'re out'
  };
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.gameMode);
  });
  document.getElementById('mode-desc').textContent = modeDescs[state.gameMode] ?? '';

  const startBtn  = document.getElementById('btn-start');
  const hint      = document.getElementById('start-hint');
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

document.getElementById('mode-btns').addEventListener('click', e => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  socket.emit('set_mode', { mode: btn.dataset.mode });
});

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
  myDice = [];
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

socket.on('your_dice', ({ dice }) => {
  myDice = dice;
  dealMyDice();
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
    const total = gs.players.reduce((s, p) => s + p.diceCount, 0);
    const qm = total / 3;
    document.getElementById('qm-value').textContent = Number.isInteger(qm) ? String(qm) : qm.toFixed(2);
    document.getElementById('total-dice-note').textContent = ` (${total} dice in play)`;
  }
}

function renderStatus() {
  const bar = document.getElementById('status-bar');
  if (gs.currentPlayerId === myId) {
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
  // Auto-scroll to bottom so latest bid is visible when open
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
  dealGeneration++; // cancel any in-progress deal animation
  document.getElementById('my-dice').innerHTML =
    [...myDice].sort((a, b) => a - b).map(d => make3DDie(d)).join('');
}

function dealMyDice() {
  const gen = ++dealGeneration;
  const container = document.getElementById('my-dice');
  const finalDice = [...myDice].sort((a, b) => a - b);
  if (!finalDice.length) { container.innerHTML = ''; return; }

  const facesHtml = die3FacesHtml();
  container.innerHTML = finalDice.map(() =>
    `<div class="die3-wrap"><div class="die3">${facesHtml}</div></div>`
  ).join('');

  const cubes = [...container.querySelectorAll('.die3')];
  const wraps = [...container.querySelectorAll('.die3-wrap')];

  // Instant random starting position (no transition)
  cubes.forEach(c => { c.style.transition = 'none'; c.style.transform = randomTumble(); });

  let ticks = 0;
  const shuffleTicks = 5;

  function tick() {
    if (gen !== dealGeneration) return;
    if (ticks < shuffleTicks) {
      cubes.forEach(c => {
        c.style.transition = 'transform 180ms ease-in-out';
        c.style.transform = randomTumble();
      });
      ticks++;
      setTimeout(tick, 200);
    } else {
      // Land on correct face with bounce
      cubes.forEach((c, i) => {
        c.style.transition = 'transform 480ms cubic-bezier(0.34,1.56,0.64,1)';
        c.style.transform = FACE3_TRANSFORMS[finalDice[i]];
      });
      wraps.forEach((w, i) => {
        w.style.animationDelay = `${i * 55}ms`;
        w.classList.add('die3-landing');
      });
    }
  }

  // Two rAFs so the initial transform renders before transitions begin
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen !== dealGeneration) return;
    tick();
  }));
}

function renderActionUI() {
  const isMyTurn = gs.currentPlayerId === myId && gs.phase === 'playing';
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

    if (gs.isPalifico && gs.palificoFace !== null && myDice.length > 1) {
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
  socket.emit('make_bid', { quantity: selQty, face: gs.isFaceoff ? 0 : selFace });
});

document.getElementById('btn-challenge').addEventListener('click', () => {
  socket.emit('challenge');
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

  // Re-trigger spin animation on wrapper (label rides inside it)
  wrap.style.animation = 'none';
  void wrap.offsetWidth;
  wrap.style.animation = '';

  showEl(overlay);

  // After 2s: swap phases
  setTimeout(() => {
    hideEl(phase1);

    // Re-trigger reveal animations
    aboveEl.style.animation = 'none';
    document.getElementById('woah-send').style.animation = 'none';
    void aboveEl.offsetWidth;
    aboveEl.style.animation = '';
    document.getElementById('woah-send').style.animation = '';

    showEl(phase2);

    // Auto-hide after 2.5s
    setTimeout(() => hideEl(overlay), 2500);
  }, 2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bid made
// ─────────────────────────────────────────────────────────────────────────────
socket.on('bid_made', ({ bid, bidderName, gameState: state }) => {
  const wasFirstBid = gs.firstBidOfRound;
  gs = state;
  bidHistory.push({ type: 'bid', name: bidderName, qty: bid.quantity, face: bid.face });
  renderGame();
  renderBidHistory();
  if (bidderName !== myName) {
    if (state.isFaceoff) {
      toast(`${bidderName} bid sum ${bid.quantity}`);
    } else {
      toast(`${bidderName} bid ${bid.quantity} ${FACE_NAME[bid.face]}`);
    }
  }

  if (wasFirstBid && !state.isFaceoff) {
    const totalDice = state.players.reduce((s, p) => s + p.diceCount, 0);
    const quickMath = totalDice / 3;
    if (bid.quantity >= quickMath + 2) {
      showWoahOverlay(Math.round(bid.quantity - quickMath));
    }
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
  setTimeout(() => hideEl(overlay), 1800);
});

// ─────────────────────────────────────────────────────────────────────────────
// Challenge reveal
// ─────────────────────────────────────────────────────────────────────────────
socket.on('challenge_result', result => {
  hideEl('action-ui');
  showReveal(result);
});

socket.on('reveal_resolved', () => {
  showEl('btn-next-round');
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  hideEl('btn-next-round');
  socket.emit('next_round');
});

function showReveal(r) {
  const { revealedDice, bid, count, bidMet, isPalifico, isFaceoff, gameMode, bidderName, challengerName, loserName } = r;

  let playersRowHtml, bottomRowHtml;

  if (isFaceoff) {
    // Show every die for every player (no filtering — all dice are relevant)
    playersRowHtml = revealedDice.map(pd => {
      const color = PLAYER_COLORS[pd.colorIndex ?? 0];
      const isMe  = pd.id === myId;
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
    // Standard/palifico: show only relevant dice per player
    playersRowHtml = revealedDice.map(pd => {
      const color = PLAYER_COLORS[pd.colorIndex ?? 0];
      const isMe  = pd.id === myId;
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

  const outcomeText = isFaceoff
    ? (bidMet
        ? `✗ Call unsuccessful — sum is ${count} ≥ ${bid.quantity}, <strong>${esc(challengerName)}</strong> loses`
        : `✓ Call successful — sum is ${count}, bid was ${bid.quantity}, <strong>${esc(bidderName)}</strong> loses`)
    : (bidMet
        ? `✗ Call unsuccessful — <strong>${esc(challengerName)}</strong> loses${gameMode === 'reverse' ? '' : ' a die'}`
        : `✓ Call successful — <strong>${esc(bidderName)}</strong> loses${gameMode === 'reverse' ? '' : ' a die'}`);

  document.getElementById('reveal-all-dice').innerHTML = `
    <div class="reveal-players-row">${playersRowHtml}</div>
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
socket.on('player_eliminated', ({ playerName, reason }) => {
  if (reason === 'disconnect') {
    const disconnectQuips = [
      `${playerName} lagged out of reality`,
      `${playerName} lost connection faster than they lost the game`,
      `${playerName} has been claimed by unstable Wi-Fi`,
      `${playerName} timed out while searching for better luck`,
      `${playerName} has been defeated by ping`,
    ];
    toast(disconnectQuips[Math.floor(Math.random() * disconnectQuips.length)], 'warn');
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
socket.on('game_over', ({ winner, reason, quitterName }) => {
  hideEl('reveal-overlay');
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
  localStorage.removeItem('perudoSession');
  myName = null;
  myDice = [];
  gs     = null;
  bidHistory = [];
  document.getElementById('name-input').value = '';
  showScreen('screen-name');
  socket.emit('leave_room');
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

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────
socket.on('player_disconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} has disconnected`, 'warn');
  if (gs?.phase === 'playing') renderGame();
});

socket.on('player_reconnected', ({ playerName, gameState: state }) => {
  if (state) gs = state;
  toast(`${playerName} reconnected`, 'ok');
  if (gs?.phase === 'playing') renderGame();
});

socket.on('disconnect', () => toast('Connection lost — reconnecting…', 'warn'));
