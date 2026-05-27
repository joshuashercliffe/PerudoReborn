const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000 });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// All active players join the 'game' socket.io room for broadcasts
const ROOM = 'game';

// Single global game state
const room = {
  phase: 'lobby', // lobby | playing | reveal | over
  players: [],
  host: null,
  currentPlayerIndex: 0,
  lastBidderIndex: -1,
  currentBid: null,
  firstBidOfRound: true,
  isPalifico: false,
  palificoFace: null,
  palificoTriggerPlayer: null,
  roundNumber: 0
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
      connected: p.connected
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayerId: cp?.id ?? null,
    currentPlayerName: cp?.name ?? null,
    currentBid: room.currentBid,
    firstBidOfRound: room.firstBidOfRound,
    isPalifico: room.isPalifico,
    palificoFace: room.palificoFace,
    roundNumber: room.roundNumber,
    host: room.host,
    totalDice: room.players.reduce((s, p) => s + p.diceCount, 0)
  };
}

function resetToLobby() {
  room.phase = 'lobby';
  room.currentBid = null;
  room.firstBidOfRound = true;
  room.isPalifico = false;
  room.palificoFace = null;
  room.palificoTriggerPlayer = null;
  room.currentPlayerIndex = 0;
  room.lastBidderIndex = -1;
  room.roundNumber = 0;
  room.players.forEach(p => { p.diceCount = 5; p.dice = []; p.connected = true; });
  if (room.players.length > 0 && !room.players.find(p => p.id === room.host)) {
    room.host = room.players[0].id;
  }
}

// ─────────────────────────────────────────
// Bid validation (single source of truth)
// ─────────────────────────────────────────

function validateBid(qty, face) {
  if (!Number.isInteger(face) || face < 1 || face > 6) return { valid: false, reason: 'Invalid face value' };
  if (!Number.isInteger(qty) || qty < 1) return { valid: false, reason: 'Quantity must be at least 1' };

  const cur = room.currentBid;

  if (!cur) {
    if (face === 1) return { valid: false, reason: 'Cannot open a round with 1s' };
    return { valid: true };
  }

  if (room.isPalifico) {
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

  const cp = room.players[room.currentPlayerIndex];
  if (room.palificoTriggerPlayer && room.palificoTriggerPlayer === cp?.id) {
    room.isPalifico = true;
    room.palificoFace = null;
    room.palificoTriggerPlayer = null;
  } else {
    room.isPalifico = false;
    room.palificoFace = null;
  }

  room.players.forEach(p => {
    p.dice = roll(p.diceCount);
    io.to(p.id).emit('your_dice', { dice: p.dice });
  });

  io.to(ROOM).emit('round_start', publicState());
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

  // ── Start game ────────────────────────
  socket.on('start_game', () => {
    if (room.phase !== 'lobby') return;
    if (!room.players.find(p => p.id === socket.id)) return;
    if (room.players.length < 2) return socket.emit('start_error', { message: 'Need at least 2 players to start.' });

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

    if (room.isPalifico && room.firstBidOfRound) room.palificoFace = f;

    room.lastBidderIndex  = room.currentPlayerIndex;
    room.currentBid       = { quantity: qty, face: f };
    room.firstBidOfRound  = false;
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;

    io.to(ROOM).emit('bid_made', { bid: room.currentBid, bidderName: cp.name, gameState: publicState() });
  });

  // ── Challenge (Liar) ──────────────────
  socket.on('challenge', () => {
    if (room.phase !== 'playing' || room.firstBidOfRound) return;
    const challenger = room.players[room.currentPlayerIndex];
    if (!challenger || challenger.id !== socket.id) return;
    const bidder = room.players[room.lastBidderIndex];
    if (!bidder) return;

    room.phase = 'reveal';

    // Tell all clients someone called LIAR — shown for 1.2s before reveal
    io.to(ROOM).emit('liar_called', { challengerName: challenger.name });

    // Calculate result now
    const bid = room.currentBid;
    let count = 0;
    const revealedDice = room.players.map(p => {
      const pd = { id: p.id, name: p.name, dice: [...p.dice] };
      p.dice.forEach(d => {
        if (room.isPalifico) { if (d === bid.face) count++; }
        else                  { if (d === bid.face || d === 1) count++; }
      });
      return pd;
    });

    const bidMet = count >= bid.quantity;
    const loser  = bidMet ? challenger : bidder;

    const result = {
      revealedDice, bid, count, bidMet,
      isPalifico: room.isPalifico,
      bidderName: bidder.name,
      challengerName: challenger.name,
      loserName: loser.name,
      loserId: loser.id
    };

    // Emit challenge_result after LIAR animation window
    setTimeout(() => {
      io.to(ROOM).emit('challenge_result', result);

      // Resolve die loss after reveal animation (4.5s × 2.5)
      setTimeout(() => {
        const loserIdx = room.players.findIndex(p => p.id === loser.id);
        if (loserIdx === -1) return;

        const loserPlayer = room.players[loserIdx];
        loserPlayer.diceCount--;

        if (loserPlayer.diceCount <= 0) {
          loserPlayer.diceCount = 0;
          loserPlayer.dice = [];

          io.to(ROOM).emit('player_eliminated', {
            playerId: loserPlayer.id,
            playerName: loserPlayer.name
          });
          room.players.splice(loserIdx, 1);

          if (room.players.length === 1) {
            room.phase = 'over';
            io.to(ROOM).emit('game_over', { winner: room.players[0].name });
            return;
          }

          room.palificoTriggerPlayer = null;
          // Loser eliminated — next player at that position goes first
          room.currentPlayerIndex = loserIdx % room.players.length;
        } else {
          loserPlayer.dice = loserPlayer.dice.slice(0, loserPlayer.diceCount);
          // Loser goes first next round
          room.currentPlayerIndex = loserIdx;
          if (loserPlayer.diceCount === 1) room.palificoTriggerPlayer = loserPlayer.id;
        }

        room.roundNumber++;
        setTimeout(() => startRound(), 4000);
      }, 9000);
    }, 1200);
  });

  // ── Rage quit ─────────────────────────
  socket.on('rage_quit', () => {
    if (room.phase !== 'playing' && room.phase !== 'reveal') return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const player = room.players[idx];
    room.players.splice(idx, 1);
    io.to(ROOM).emit('player_eliminated', { playerId: socket.id, playerName: player.name });

    if (room.players.length <= 1) {
      room.phase = 'over';
      io.to(ROOM).emit('game_over', { winner: room.players[0]?.name ?? 'Nobody' });
      return;
    }

    // Keep lastBidderIndex valid
    if (room.lastBidderIndex >= room.players.length) room.lastBidderIndex = -1;
    if (room.lastBidderIndex > idx) room.lastBidderIndex--;

    // Advance turn pointer
    if (idx < room.currentPlayerIndex) {
      room.currentPlayerIndex--;
    } else {
      room.currentPlayerIndex = room.currentPlayerIndex % room.players.length;
    }

    room.roundNumber++;
    setTimeout(() => startRound(), 1500);
  });

  // ── Return to lobby after game ────────
  socket.on('return_to_lobby', () => {
    if (!room.players.find(p => p.id === socket.id)) return;
    if (room.phase !== 'over') return;
    resetToLobby();
    io.to(ROOM).emit('lobby_update', publicState());
  });

  // ── Disconnect ────────────────────────
  socket.on('disconnect', () => {
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const player = room.players[idx];
    player.connected = false;

    if (room.phase === 'lobby' || room.phase === 'over') {
      // Give 60s grace in lobby/over too so a phone lock doesn't kick them
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
      // In-game: mark disconnected, give 60s to reconnect before eliminating
      io.to(ROOM).emit('player_disconnected', { playerName: player.name, gameState: publicState() });

      player.disconnectTimer = setTimeout(() => {
        // If player reconnected their id changed — findIndex returns -1 and we bail
        const stillIdx = room.players.findIndex(p => p.id === socket.id);
        if (stillIdx === -1 || room.players[stillIdx].connected) return;

        room.players.splice(stillIdx, 1);
        io.to(ROOM).emit('player_eliminated', { playerId: socket.id, playerName: player.name });

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
