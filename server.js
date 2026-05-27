const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000 });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// All active players join the 'game' socket.io room for broadcasts
const ROOM = 'game';

// Single global game state
const room = {
  phase: 'lobby', // lobby | playing | reveal | over
  gameMode: 'standard', // standard | reverse
  players: [],
  host: null,
  currentPlayerIndex: 0,
  lastBidderIndex: -1,
  currentBid: null,
  firstBidOfRound: true,
  isPalifico: false,
  isFaceoff: false,
  palificoFace: null,
  palificoTriggerPlayer: null,
  roundNumber: 0,
  revealResolved: false,
  autoLiarPlayerId: null
};

// sessionToken -> socketId  (for reconnection)
const sessions = {};

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function roll(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 6) + 1);
}

function publicState() {
  const cp = room.players[room.currentPlayerIndex];
  return {
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      diceCount: p.diceCount,
      connected: p.connected,
      colorIndex: p.colorIndex ?? 0
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayerId: cp?.id ?? null,
    currentPlayerName: cp?.name ?? null,
    currentBid: room.currentBid,
    firstBidOfRound: room.firstBidOfRound,
    isPalifico: room.isPalifico,
    isFaceoff: room.isFaceoff,
    palificoFace: room.palificoFace,
    roundNumber: room.roundNumber,
    host: room.host,
    totalDice: room.players.reduce((s, p) => s + p.diceCount, 0),
    gameMode: room.gameMode,
  autoLiarPlayerId: room.autoLiarPlayerId
  };
}

function purgeDead() {
  room.players = room.players.filter(p => {
    if (!p.connected) {
      if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
      return false;
    }
    return true;
  });
}

function resetToLobby() {
  purgeDead(); // drop any disconnected players so they don't carry over
  room.phase = 'lobby';
  room.currentBid = null;
  room.firstBidOfRound = true;
  room.isPalifico = false;
  room.isFaceoff = false;
  room.palificoFace = null;
  room.palificoTriggerPlayer = null;
  room.currentPlayerIndex = 0;
  room.lastBidderIndex = -1;
  room.roundNumber = 0;
  room.autoLiarPlayerId = null;
  const startDice = room.gameMode === 'reverse' ? 1 : 5;
  room.players.forEach(p => { p.diceCount = startDice; p.dice = []; });
  if (room.players.length > 0 && !room.players.find(p => p.id === room.host)) {
    room.host = room.players[0].id;
  }
}

// ─────────────────────────────────────────
// Peak detection
// ─────────────────────────────────────────
function countForFace(face, allDice) {
  if (face === 1) return allDice.filter(d => d === 1).length;
  return allDice.filter(d => d === face || d === 1).length;
}

function checkIsPeak(bid, allDice, room, challenger) {
  if (!bid) return false;

  // ── Faceoff ──────────────────────────────────────────────────────────────
  // Peak if the bid exactly equals the actual sum — challenger had no higher
  // truthful option (any bid above the true sum would be a lie).
  if (room.isFaceoff) {
    const actualSum = allDice.reduce((s, d) => s + d, 0);
    return bid.quantity === actualSum;
  }

  // ── Palifico ─────────────────────────────────────────────────────────────
  // No wild 1s in palifico — all counts are exact face matches.
  if (room.isPalifico) {
    const exactCount = allDice.filter(d => d === bid.face).length;
    if (exactCount !== bid.quantity) return false;

    if (challenger.diceCount === 1) {
      // 1-die player follows standard raise rules and CAN change pip.
      // Peak only if no higher truthful bid exists for them:
      //   - same qty, higher face
      for (let f = bid.face + 1; f <= 6; f++) {
        if (allDice.filter(d => d === f).length >= bid.quantity) return false;
      }
      //   - higher qty, any face
      for (let f = 1; f <= 6; f++) {
        if (allDice.filter(d => d === f).length >= bid.quantity + 1) return false;
      }
      return true;
    } else {
      // Multi-die player is locked to the palifico face; only valid raise is
      // qty+1 of the same face. Since exactCount === bid.quantity, qty+1
      // of that face would be a lie — no valid higher bid exists.
      return true;
    }
  }

  // ── Standard ─────────────────────────────────────────────────────────────
  if (bid.face === null) return false;
  const matchCount = countForFace(bid.face, allDice);
  if (matchCount !== bid.quantity) return false;

  const ones = allDice.filter(d => d === 1).length;

  if (bid.face === 1) {
    // From a 1s bid: raise 1s directly (qty+1), or switch to non-1s (requires qty >= bid.quantity*2)
    if (ones >= bid.quantity + 1) return false;
    for (let f = 2; f <= 6; f++) {
      if (countForFace(f, allDice) >= bid.quantity * 2) return false;
    }
  } else {
    // From a non-1s bid: same qty higher face, or higher qty any non-1 face
    for (let f = bid.face + 1; f <= 6; f++) {
      if (countForFace(f, allDice) >= bid.quantity) return false;
    }
    for (let f = 2; f <= 6; f++) {
      if (countForFace(f, allDice) >= bid.quantity + 1) return false;
    }
    // Switch to 1s requires qty >= ceil(bid.quantity / 2)
    if (ones >= Math.ceil(bid.quantity / 2)) return false;
  }
  return true;
}

// ─────────────────────────────────────────
// Bid validation (single source of truth)
// ─────────────────────────────────────────

function validateBid(qty, face) {
  if (!Number.isInteger(qty) || qty < 1) return { valid: false, reason: 'Quantity must be at least 1' };

  // Faceoff: bid is a claimed sum of both dice (2–12), no face needed
  if (room.isFaceoff) {
    if (qty > 12) return { valid: false, reason: 'Sum cannot exceed 12' };
    if (!room.currentBid) return { valid: true };
    if (qty <= room.currentBid.quantity) return { valid: false, reason: 'Must bid a higher sum' };
    return { valid: true };
  }

  if (!Number.isInteger(face) || face < 1 || face > 6) return { valid: false, reason: 'Invalid face value' };

  const cur = room.currentBid;

  if (!cur) {
    if (!room.isPalifico && face === 1) return { valid: false, reason: 'Cannot open a round with 1s' };
    return { valid: true };
  }

  if (room.isPalifico) {
    const cp = room.players[room.currentPlayerIndex];
    if (cp && cp.diceCount === 1) {
      // Player with 1 die uses standard raise rules (may change face)
      if (qty > cur.quantity) return { valid: true };
      if (qty === cur.quantity && face > cur.face) return { valid: true };
      return { valid: false, reason: 'Must raise quantity or bid same quantity of higher face' };
    }
    if (room.palificoFace !== null && face !== room.palificoFace)
      return { valid: false, reason: `Palifico: must bid on ${room.palificoFace}s` };
    if (qty <= cur.quantity) return { valid: false, reason: 'Palifico: must raise quantity' };
    return { valid: true };
  }

  if (cur.face !== 1 && face === 1) {
    const min = Math.ceil(cur.quantity / 2);
    if (qty < min) return { valid: false, reason: `Need at least ${min} ones to switch to 1s` };
    return { valid: true };
  }

  if (cur.face === 1 && face !== 1) {
    const min = cur.quantity * 2;
    if (qty < min) return { valid: false, reason: `Need at least ${min} to switch from 1s` };
    return { valid: true };
  }

  if (qty > cur.quantity) return { valid: true };
  if (qty === cur.quantity && face > cur.face) return { valid: true };
  return { valid: false, reason: 'Bid must be strictly higher (more dice, or same qty of higher face)' };
}

// ─────────────────────────────────────────
// Round management
// ─────────────────────────────────────────

function startRound() {
  room.phase = 'playing';
  room.currentBid = null;
  room.firstBidOfRound = true;
  room.lastBidderIndex = -1;
  room.revealResolved = false;

  // Faceoff: 2 players each with exactly 1 die — takes priority over palifico
  const isFaceoffRound = room.players.length === 2 && room.players.every(p => p.diceCount === 1);
  if (isFaceoffRound) {
    room.isFaceoff = true;
    room.isPalifico = false;
    room.palificoFace = null;
    room.palificoTriggerPlayer = null;
  } else {
    room.isFaceoff = false;
    const cp = room.players[room.currentPlayerIndex];
    if (room.palificoTriggerPlayer && room.palificoTriggerPlayer === cp?.id) {
      room.isPalifico = true;
      room.palificoFace = null;
      room.palificoTriggerPlayer = null;
    } else {
      room.isPalifico = false;
      room.palificoFace = null;
    }
  }

  room.players.forEach(p => {
    p.dice = roll(p.diceCount);
  });

  io.to(ROOM).emit('round_start', publicState());

  room.players.forEach(p => {
    io.to(p.id).emit('your_dice', { dice: p.dice });
  });
}

// ─────────────────────────────────────────
// Challenge processing (shared by manual liar + autoliar)
// ─────────────────────────────────────────
function processChallenge(challenger) {
  const bidder = room.players[room.lastBidderIndex];
  if (!bidder) return;

  room.phase = 'reveal';

  const allDice = room.players.flatMap(p => p.dice);
  const isPeak = checkIsPeak(room.currentBid, allDice, room, challenger);

  io.to(ROOM).emit('liar_called', { challengerName: challenger.name, isPeak });

  const bid = room.currentBid;
  let count = 0;
  const revealedDice = room.players.map(p => {
    const pd = { id: p.id, name: p.name, dice: [...p.dice], colorIndex: p.colorIndex ?? 0 };
    if (room.isFaceoff) {
      count += p.dice.reduce((s, d) => s + d, 0);
    } else {
      p.dice.forEach(d => {
        if (room.isPalifico) { if (d === bid.face) count++; }
        else                  { if (d === bid.face || d === 1) count++; }
      });
    }
    return pd;
  });

  const bidMet = count >= bid.quantity;
  const loser  = bidMet ? challenger : bidder;

  const result = {
    revealedDice, bid, count, bidMet,
    isPalifico: room.isPalifico,
    isFaceoff: room.isFaceoff,
    gameMode: room.gameMode,
    bidderName: bidder.name,
    challengerName: challenger.name,
    loserName: loser.name,
    loserId: loser.id
  };

  setTimeout(() => {
    io.to(ROOM).emit('challenge_result', result);

    setTimeout(() => {
      const loserIdx = room.players.findIndex(p => p.id === loser.id);
      if (loserIdx === -1) return;

      const loserPlayer = room.players[loserIdx];

      if (room.gameMode === 'reverse') {
        loserPlayer.diceCount++;

        if (loserPlayer.diceCount > 5) {
          loserPlayer.diceCount = 0;
          loserPlayer.dice = [];
          if (room.autoLiarPlayerId === loserPlayer.id) room.autoLiarPlayerId = null;

          io.to(ROOM).emit('player_eliminated', { playerId: loserPlayer.id, playerName: loserPlayer.name });
          room.players.splice(loserIdx, 1);

          if (room.players.length === 1) {
            room.phase = 'over';
            io.to(ROOM).emit('game_over', { winner: room.players[0].name });
            return;
          }

          room.currentPlayerIndex = loserIdx % room.players.length;
        } else {
          room.currentPlayerIndex = loserIdx;
        }
      } else {
        loserPlayer.diceCount--;

        if (loserPlayer.diceCount <= 0) {
          loserPlayer.diceCount = 0;
          loserPlayer.dice = [];
          if (room.autoLiarPlayerId === loserPlayer.id) room.autoLiarPlayerId = null;

          io.to(ROOM).emit('player_eliminated', { playerId: loserPlayer.id, playerName: loserPlayer.name });
          room.players.splice(loserIdx, 1);

          if (room.players.length === 1) {
            room.phase = 'over';
            io.to(ROOM).emit('game_over', { winner: room.players[0].name });
            return;
          }

          room.palificoTriggerPlayer = null;
          room.currentPlayerIndex = loserIdx % room.players.length;
        } else {
          loserPlayer.dice = loserPlayer.dice.slice(0, loserPlayer.diceCount);
          room.currentPlayerIndex = loserIdx;
          if (loserPlayer.diceCount === 1) room.palificoTriggerPlayer = loserPlayer.id;
        }
      }

      room.roundNumber++;
      room.revealResolved = true;
      io.to(ROOM).emit('reveal_resolved');
    }, 4500);
  }, 1200);
}

// ─────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────

io.on('connection', socket => {

  // ── Rejoin with session token ─────────
  socket.on('rejoin', ({ sessionToken }) => {
    const oldSocketId = sessions[sessionToken];
    if (!oldSocketId) { socket.emit('rejoin_failed'); return; }

    const idx = room.players.findIndex(p => p.id === oldSocketId);
    if (idx === -1) {
      // Player was eliminated or never made it in — clear stale session
      delete sessions[sessionToken];
      socket.emit('rejoin_failed');
      return;
    }

    const player = room.players[idx];

    // Cancel pending elimination timer
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    // Swap in new socket
    sessions[sessionToken] = socket.id;
    if (room.host === oldSocketId) room.host = socket.id;
    player.id = socket.id;
    player.connected = true;
    socket.playerName = player.name;
    socket.join(ROOM);

    socket.emit('rejoined', {
      sessionToken,
      state: publicState(),
      dice: player.dice,
      phase: room.phase
    });

    socket.to(ROOM).emit('player_reconnected', {
      playerName: player.name,
      gameState: publicState()
    });
  });

  // ── Join lobby ────────────────────────
  socket.on('set_name', ({ name }) => {
    const n = String(name ?? '').trim().slice(0, 20);
    if (!n) return;

    // Block joining mid-game
    if (room.phase === 'playing' || room.phase === 'reveal') {
      return socket.emit('join_error', { message: 'A game is already in progress. Please wait for it to finish.' });
    }

    // Deduplicate name
    let finalName = n;
    while (room.players.find(p => p.name === finalName)) finalName += '_';
    socket.playerName = finalName;

    const token = crypto.randomUUID();
    const player = { id: socket.id, name: finalName, diceCount: 5, dice: [], connected: true };
    sessions[token] = socket.id;
    room.players.push(player);
    if (room.players.length === 1) room.host = socket.id;

    socket.join(ROOM);
    socket.emit('joined_lobby', { ...publicState(), sessionToken: token });
    socket.to(ROOM).emit('lobby_update', publicState());
  });

  // ── Set game mode ─────────────────────
  socket.on('set_mode', ({ mode }) => {
    if (room.phase !== 'lobby') return;
    if (!['standard', 'reverse'].includes(mode)) return;
    room.gameMode = mode;
    io.to(ROOM).emit('lobby_update', publicState());
  });

  // ── Start game ────────────────────────
  socket.on('start_game', () => {
    if (room.phase !== 'lobby') return;
    if (!room.players.find(p => p.id === socket.id)) return;
    purgeDead(); // remove anyone who dropped during the lobby
    if (room.players.length < 2) return socket.emit('start_error', { message: 'Need at least 2 players to start.' });

    const startDice = room.gameMode === 'reverse' ? 1 : 5;
    room.players.forEach((p, i) => { p.diceCount = startDice; p.dice = []; p.colorIndex = i; });
    room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
    room.roundNumber = 1;
    room.palificoTriggerPlayer = null;
    startRound();
  });

  // ── Make bid ──────────────────────────
  socket.on('make_bid', ({ quantity, face }) => {
    if (room.phase !== 'playing') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return;

    const qty = parseInt(quantity, 10);
    const f   = parseInt(face, 10);
    const check = validateBid(qty, f);
    if (!check.valid) return socket.emit('bid_error', { message: check.reason });

    if (room.isPalifico && room.firstBidOfRound) {
      room.palificoFace = f;
    } else if (room.isPalifico && cp.diceCount === 1 && f !== room.palificoFace) {
      room.palificoFace = f; // 1-die player changed face — update the round constraint
    }

    room.lastBidderIndex  = room.currentPlayerIndex;
    room.currentBid       = { quantity: qty, face: room.isFaceoff ? null : f };
    room.firstBidOfRound  = false;
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;

    io.to(ROOM).emit('bid_made', { bid: room.currentBid, bidderName: cp.name, gameState: publicState() });

    // Auto-liar: fire challenge if the new current player has it locked
    if (room.autoLiarPlayerId) {
      const newCurrent = room.players[room.currentPlayerIndex];
      if (newCurrent?.id === room.autoLiarPlayerId) {
        room.autoLiarPlayerId = null;
        setImmediate(() => processChallenge(newCurrent));
      }
    }
  });

  // ── Auto-liar (lock in a liar call for your next turn) ────────────────
  socket.on('auto_liar', () => {
    if (room.phase !== 'playing') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    // Can't lock autoliar on your own turn
    if (room.players[room.currentPlayerIndex]?.id === socket.id) return;

    if (room.autoLiarPlayerId === socket.id) return; // already locked — ignore
    room.autoLiarPlayerId = socket.id;
    io.to(ROOM).emit('auto_liar_update', { playerId: socket.id, playerName: p.name, active: true });
  });

  // ── Challenge (Liar) ──────────────────
  socket.on('challenge', () => {
    if (room.phase !== 'playing' || room.firstBidOfRound) return;
    const challenger = room.players[room.currentPlayerIndex];
    if (!challenger || challenger.id !== socket.id) return;
    processChallenge(challenger);
  });

  // ── Rage quit ─────────────────────────
  socket.on('rage_quit', () => {
    if (room.phase !== 'playing' && room.phase !== 'reveal') return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const player = room.players[idx];
    room.players.splice(idx, 1);
    room.phase = 'over';
    io.to(ROOM).emit('game_over', {
      winner: room.players[0]?.name ?? 'Nobody',
      reason: 'rage_quit',
      quitterName: player.name
    });
  });

  // ── Next round (player-triggered) ─────
  socket.on('next_round', () => {
    if (room.phase !== 'reveal' || !room.revealResolved) return;
    if (!room.players.find(p => p.id === socket.id)) return;
    room.revealResolved = false; // first click wins, prevent double-start
    startRound();
  });

  // ── Reactions ────────────────────────────────────────────────────────
  socket.on('reaction', ({ type }) => {
    if (!['fire', 'ice'].includes(type)) return;
    io.to(ROOM).emit('reaction', { type });
  });

  // ── Leave room (play again → everyone back to name entry) ────────────
  socket.on('leave_room', () => {
    // Send every connected player back to the name screen
    io.to(ROOM).emit('game_reset');
    // Clear all sessions so stale rejoin tokens don't work
    Object.keys(sessions).forEach(t => delete sessions[t]);
    // Cancel disconnect timers and wipe the room
    room.players.forEach(p => {
      if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    });
    room.players = [];
    resetToLobby();
  });

  // ── Disconnect ────────────────────────
  socket.on('disconnect', () => {
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const player = room.players[idx];
    player.connected = false;

    if (room.phase === 'lobby' || room.phase === 'over') {
      // 30s grace in lobby so a phone screen-lock doesn't immediately kick them
      io.to(ROOM).emit('lobby_update', publicState());

      player.disconnectTimer = setTimeout(() => {
        const stillIdx = room.players.findIndex(p => p.id === socket.id);
        if (stillIdx === -1 || room.players[stillIdx].connected) return;

        const wasHost = room.host === socket.id;
        room.players.splice(stillIdx, 1);
        if (wasHost && room.players.length > 0) room.host = room.players[0].id;
        io.to(ROOM).emit('lobby_update', publicState());
      }, 60000);
    } else {
      // In-game: 60s to reconnect before being eliminated
      io.to(ROOM).emit('player_disconnected', { playerName: player.name, gameState: publicState() });

      player.disconnectTimer = setTimeout(() => {
        const stillIdx = room.players.findIndex(p => p.id === socket.id);
        if (stillIdx === -1 || room.players[stillIdx].connected) return;

        room.players.splice(stillIdx, 1);
        io.to(ROOM).emit('player_eliminated', { playerId: socket.id, playerName: player.name, reason: 'disconnect' });

        if (room.players.length <= 1) {
          room.phase = 'over';
          io.to(ROOM).emit('game_over', { winner: room.players[0]?.name ?? 'Nobody' });
          return;
        }

        if (room.currentPlayerIndex >= room.players.length) {
          room.currentPlayerIndex = 0;
        }

        if (room.phase === 'playing') {
          room.roundNumber++;
          setTimeout(() => startRound(), 1000);
        }
      }, 60000);
    }
  });
});

server.listen(PORT, () => console.log(`Perudo running on port ${PORT}`));
