const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000 });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// In-memory state
const rooms = {};       // code -> room
const playerRoom = {};  // socketId -> roomCode

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function roll(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 6) + 1);
}

function publicState(room) {
  const cp = room.players[room.currentPlayerIndex];
  return {
    code: room.code,
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

// ─────────────────────────────────────────
// Bid validation (single source of truth)
// ─────────────────────────────────────────

function validateBid(room, qty, face) {
  if (!Number.isInteger(face) || face < 1 || face > 6) return { valid: false, reason: 'Invalid face value' };
  if (!Number.isInteger(qty) || qty < 1) return { valid: false, reason: 'Quantity must be at least 1' };

  const cur = room.currentBid;

  // Opening bid of the round
  if (!cur) {
    if (face === 1) return { valid: false, reason: 'Cannot open a round with 1s' };
    return { valid: true };
  }

  // Palifico: must match locked face, must increase qty
  if (room.isPalifico) {
    if (room.palificoFace !== null && face !== room.palificoFace) {
      return { valid: false, reason: `Palifico: must bid on ${room.palificoFace}s` };
    }
    if (qty <= cur.quantity) return { valid: false, reason: 'Palifico: must raise quantity' };
    return { valid: true };
  }

  // Switch non-1s → 1s: qty >= ceil(cur.qty / 2)
  if (cur.face !== 1 && face === 1) {
    const min = Math.ceil(cur.quantity / 2);
    if (qty < min) return { valid: false, reason: `Need at least ${min} ones to switch to 1s` };
    return { valid: true };
  }

  // Switch 1s → non-1s: qty >= cur.qty * 2
  if (cur.face === 1 && face !== 1) {
    const min = cur.quantity * 2;
    if (qty < min) return { valid: false, reason: `Need at least ${min} to switch from 1s` };
    return { valid: true };
  }

  // Normal strictly-higher rule
  if (qty > cur.quantity) return { valid: true };
  if (qty === cur.quantity && face > cur.face) return { valid: true };
  return { valid: false, reason: 'Bid must be strictly higher (more dice, or same qty of higher face)' };
}

// ─────────────────────────────────────────
// Round management
// ─────────────────────────────────────────

function startRound(room) {
  room.phase = 'playing';
  room.currentBid = null;
  room.firstBidOfRound = true;
  room.lastBidderIndex = -1;

  // Determine Palifico
  const cp = room.players[room.currentPlayerIndex];
  if (room.palificoTriggerPlayer && room.palificoTriggerPlayer === cp?.id) {
    room.isPalifico = true;
    room.palificoFace = null;
    room.palificoTriggerPlayer = null; // one-time
  } else {
    room.isPalifico = false;
    room.palificoFace = null;
  }

  // Roll dice privately
  room.players.forEach(p => {
    p.dice = roll(p.diceCount);
    io.to(p.id).emit('your_dice', { dice: p.dice });
  });

  io.to(room.code).emit('round_start', publicState(room));
}

// ─────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────

io.on('connection', socket => {

  // ── Identity ──────────────────────────
  socket.on('set_name', ({ name }) => {
    const n = String(name ?? '').trim().slice(0, 20);
    if (!n) return;
    socket.playerName = n;
    socket.emit('name_set', { name: n });
  });

  // ── Lobby: create ─────────────────────
  socket.on('create_game', () => {
    if (!socket.playerName) return;

    const code = genCode();
    rooms[code] = {
      code,
      host: socket.id,
      phase: 'lobby',
      players: [{ id: socket.id, name: socket.playerName, dice: [], diceCount: 5, connected: true }],
      currentPlayerIndex: 0,
      lastBidderIndex: -1,
      currentBid: null,
      firstBidOfRound: true,
      isPalifico: false,
      palificoFace: null,
      palificoTriggerPlayer: null,
      roundNumber: 0
    };

    playerRoom[socket.id] = code;
    socket.join(code);
    socket.emit('game_created', { roomCode: code, gameState: publicState(rooms[code]) });
  });

  // ── Lobby: join ───────────────────────
  socket.on('join_game', ({ roomCode }) => {
    if (!socket.playerName) return;
    const code = String(roomCode ?? '').toUpperCase().trim();
    const room = rooms[code];

    if (!room) return socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });
    if (room.phase !== 'lobby') return socket.emit('join_error', { message: 'That game has already started.' });
    if (room.players.length >= 8) return socket.emit('join_error', { message: 'Room is full (max 8 players).' });

    // Deduplicate names
    let name = socket.playerName;
    while (room.players.find(p => p.name === name)) name += '_';
    socket.playerName = name;

    room.players.push({ id: socket.id, name, dice: [], diceCount: 5, connected: true });
    playerRoom[socket.id] = code;
    socket.join(code);

    socket.emit('joined_game', { roomCode: code, gameState: publicState(room) });
    socket.to(code).emit('lobby_update', publicState(room));
  });

  // ── Lobby: start ──────────────────────
  socket.on('start_game', () => {
    const code = playerRoom[socket.id];
    const room = code && rooms[code];
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    if (room.players.length < 2) return socket.emit('start_error', { message: 'Need at least 2 players to start.' });

    room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
    room.roundNumber = 1;
    room.palificoTriggerPlayer = null;
    startRound(room);
  });

  // ── Gameplay: bid ─────────────────────
  socket.on('make_bid', ({ quantity, face }) => {
    const code = playerRoom[socket.id];
    const room = code && rooms[code];
    if (!room || room.phase !== 'playing') return;

    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return;

    const qty = parseInt(quantity, 10);
    const f = parseInt(face, 10);

    const check = validateBid(room, qty, f);
    if (!check.valid) return socket.emit('bid_error', { message: check.reason });

    // Lock Palifico face on first bid of Palifico round
    if (room.isPalifico && room.firstBidOfRound) room.palificoFace = f;

    room.lastBidderIndex = room.currentPlayerIndex;
    room.currentBid = { quantity: qty, face: f };
    room.firstBidOfRound = false;

    // Advance turn (skip eliminated/disconnected? For now simple round-robin among remaining)
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;

    io.to(code).emit('bid_made', {
      bid: room.currentBid,
      bidderName: cp.name,
      gameState: publicState(room)
    });
  });

  // ── Gameplay: challenge ───────────────
  socket.on('challenge', () => {
    const code = playerRoom[socket.id];
    const room = code && rooms[code];
    if (!room || room.phase !== 'playing' || room.firstBidOfRound) return;

    const challenger = room.players[room.currentPlayerIndex];
    if (!challenger || challenger.id !== socket.id) return;

    const bidder = room.players[room.lastBidderIndex];
    if (!bidder) return;

    room.phase = 'reveal';

    // Count matching dice
    const bid = room.currentBid;
    let count = 0;
    const revealedDice = room.players.map(p => {
      const pd = { id: p.id, name: p.name, dice: [...p.dice] };
      p.dice.forEach(d => {
        if (room.isPalifico) {
          if (d === bid.face) count++;
        } else {
          if (d === bid.face || d === 1) count++;
        }
      });
      return pd;
    });

    const bidMet = count >= bid.quantity;
    const loser = bidMet ? challenger : bidder;

    io.to(code).emit('challenge_result', {
      revealedDice,
      bid,
      count,
      bidMet,
      isPalifico: room.isPalifico,
      bidderName: bidder.name,
      challengerName: challenger.name,
      loserName: loser.name,
      loserId: loser.id
    });

    // Resolve after animation window
    setTimeout(() => {
      const loserIdx = room.players.findIndex(p => p.id === loser.id);
      if (loserIdx === -1) return;

      const loserPlayer = room.players[loserIdx];
      loserPlayer.diceCount--;

      if (loserPlayer.diceCount <= 0) {
        // Eliminated
        io.to(code).emit('player_eliminated', {
          playerId: loserPlayer.id,
          playerName: loserPlayer.name
        });

        room.players.splice(loserIdx, 1);

        if (room.players.length === 1) {
          room.phase = 'over';
          io.to(code).emit('game_over', { winner: room.players[0].name });
          return;
        }

        // Wrap index after removal
        room.currentPlayerIndex = loserIdx % room.players.length;
        room.palificoTriggerPlayer = null;
      } else {
        loserPlayer.dice = loserPlayer.dice.slice(0, loserPlayer.diceCount);
        room.currentPlayerIndex = loserIdx;

        // Palifico trigger: this player now has 1 die
        if (loserPlayer.diceCount === 1) {
          room.palificoTriggerPlayer = loserPlayer.id;
        }
      }

      room.roundNumber++;
      setTimeout(() => startRound(room), 2000);
    }, 4500);
  });

  // ── Disconnect ────────────────────────
  socket.on('disconnect', () => {
    const code = playerRoom[socket.id];
    if (!code) return;
    delete playerRoom[socket.id];

    const room = rooms[code];
    if (!room) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[code]; return; }
      if (room.host === socket.id) room.host = room.players[0].id;
      io.to(code).emit('lobby_update', publicState(room));
    } else {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        io.to(code).emit('player_disconnected', { playerName: player.name, gameState: publicState(room) });
      }
    }
  });
});

server.listen(PORT, () => console.log(`Perudo running on port ${PORT}`));
