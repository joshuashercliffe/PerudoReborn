'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 60000 });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
}));

// ─────────────────────────────────────────
// Multi-room state
// ─────────────────────────────────────────

const rooms        = new Map(); // roomId -> roomState
const socketToRoom = new Map(); // socketId -> roomId
const sessions     = {};        // sessionToken -> { socketId, roomId }

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id;
  do {
    id = Array.from({ length: 4 }, () =>
      ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)]
    ).join('');
  } while (rooms.has(id));
  return id;
}

function createRoomState() {
  return {
    phase: 'lobby',
    gameMode: 'standard',
    isVariable: false,
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
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function roll(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 6) + 1);
}

function publicState(room) {
  const cp = room.players[room.currentPlayerIndex];
  return {
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id, name: p.name, diceCount: p.diceCount,
      connected: p.connected, colorIndex: p.colorIndex ?? 0
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayerId:    cp?.id   ?? null,
    currentPlayerName:  cp?.name ?? null,
    currentBid:         room.currentBid,
    firstBidOfRound:    room.firstBidOfRound,
    isPalifico:         room.isPalifico,
    isFaceoff:          room.isFaceoff,
    palificoFace:       room.palificoFace,
    roundNumber:        room.roundNumber,
    host:               room.host,
    totalDice:          room.players.reduce((s, p) => s + p.diceCount, 0),
    gameMode:           room.gameMode,
    isVariable:         room.isVariable,
    autoLiarPlayerId:   room.autoLiarPlayerId
  };
}

function purgeDead(room) {
  room.players = room.players.filter(p => {
    if (!p.connected) {
      if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
      return false;
    }
    return true;
  });
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

  if (room.isFaceoff) {
    const actualSum = allDice.reduce((s, d) => s + d, 0);
    return bid.quantity === actualSum;
  }

  if (room.isPalifico) {
    const exactCount = allDice.filter(d => d === bid.face).length;
    if (exactCount !== bid.quantity) return false;
    if (challenger.diceCount === 1) {
      for (let f = bid.face + 1; f <= 6; f++) {
        if (allDice.filter(d => d === f).length >= bid.quantity) return false;
      }
      for (let f = 1; f <= 6; f++) {
        if (allDice.filter(d => d === f).length >= bid.quantity + 1) return false;
      }
      return true;
    } else {
      return true;
    }
  }

  if (bid.face === null) return false;
  const matchCount = countForFace(bid.face, allDice);
  if (matchCount !== bid.quantity) return false;

  const ones = allDice.filter(d => d === 1).length;

  if (bid.face === 1) {
    if (ones >= bid.quantity + 1) return false;
    for (let f = 2; f <= 6; f++) {
      if (countForFace(f, allDice) >= bid.quantity * 2) return false;
    }
  } else {
    for (let f = bid.face + 1; f <= 6; f++) {
      if (countForFace(f, allDice) >= bid.quantity) return false;
    }
    for (let f = 2; f <= 6; f++) {
      if (countForFace(f, allDice) >= bid.quantity + 1) return false;
    }
    if (ones >= Math.ceil(bid.quantity / 2)) return false;
  }
  return true;
}

// ─────────────────────────────────────────
// Bid validation
// ─────────────────────────────────────────

function validateBid(qty, face, room) {
  if (!Number.isInteger(qty) || qty < 1) return { valid: false, reason: 'Quantity must be at least 1' };

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
    const min = Math.floor(cur.quantity / 2) + 1;
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

function startRound(room, roomId) {
  room.phase = 'playing';
  room.currentBid = null;
  room.firstBidOfRound = true;
  room.lastBidderIndex = -1;
  room.revealResolved = false;

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

  room.players.forEach(p => { p.dice = roll(p.diceCount); });

  io.to(roomId).emit('round_start', publicState(room));
  room.players.forEach(p => { io.to(p.id).emit('your_dice', { dice: p.dice }); });
}

// ─────────────────────────────────────────
// Challenge processing
// ─────────────────────────────────────────

function processChallenge(challenger, room, roomId) {
  const bidder = room.players[room.lastBidderIndex];
  if (!bidder) return;

  room.phase = 'reveal';

  const allDice = room.players.flatMap(p => p.dice);
  const isPeak  = checkIsPeak(room.currentBid, allDice, room, challenger);

  io.to(roomId).emit('liar_called', { challengerName: challenger.name, isPeak });

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

  const bidMet   = count >= bid.quantity;
  const loser    = bidMet ? challenger : bidder;
  const rawDelta = (room.isVariable && !room.isFaceoff)
    ? (bidMet ? count - bid.quantity + 1 : bid.quantity - count)
    : 1;
  const diceDelta = Math.min(rawDelta, loser.diceCount);

  const result = {
    revealedDice, bid, count, bidMet,
    isPeak, diceDelta,
    isPalifico:     room.isPalifico,
    isFaceoff:      room.isFaceoff,
    gameMode:       room.gameMode,
    bidderName:     bidder.name,
    challengerName: challenger.name,
    loserName:      loser.name,
    loserId:        loser.id
  };

  setTimeout(() => {
    io.to(roomId).emit('challenge_result', result);

    setTimeout(() => {
      const loserIdx = room.players.findIndex(p => p.id === loser.id);
      if (loserIdx === -1) {
        if (room.phase !== 'over') {
          room.roundNumber++;
          room.revealResolved = true;
          io.to(roomId).emit('reveal_resolved');
        }
        return;
      }

      const loserPlayer = room.players[loserIdx];

      if (room.gameMode === 'reverse') {
        loserPlayer.diceCount += result.diceDelta;

        if (loserPlayer.diceCount > 5) {
          loserPlayer.diceCount = 0;
          loserPlayer.dice = [];
          if (room.autoLiarPlayerId === loserPlayer.id) room.autoLiarPlayerId = null;

          io.to(roomId).emit('player_eliminated', { playerId: loserPlayer.id, playerName: loserPlayer.name });
          room.players.splice(loserIdx, 1);

          if (room.players.length === 1) {
            room.phase = 'over';
            io.to(roomId).emit('game_over', { winner: room.players[0].name });
            return;
          }
          room.currentPlayerIndex = loserIdx % room.players.length;
        } else {
          room.currentPlayerIndex = loserIdx;
        }
      } else {
        loserPlayer.diceCount -= result.diceDelta;

        if (loserPlayer.diceCount <= 0) {
          loserPlayer.diceCount = 0;
          loserPlayer.dice = [];
          if (room.autoLiarPlayerId === loserPlayer.id) room.autoLiarPlayerId = null;

          io.to(roomId).emit('player_eliminated', { playerId: loserPlayer.id, playerName: loserPlayer.name });
          room.players.splice(loserIdx, 1);

          if (room.players.length === 1) {
            room.phase = 'over';
            io.to(roomId).emit('game_over', { winner: room.players[0].name });
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
      io.to(roomId).emit('reveal_resolved');
    }, 4500);
  }, 1200);
}

// ─────────────────────────────────────────
// Socket.io
// ─────────────────────────────────────────

io.on('connection', socket => {

  function getRoom() {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return null;
    const room = rooms.get(roomId);
    if (!room) return null;
    return { room, roomId };
  }

  // ── Create room ───────────────────────
  socket.on('create_room', () => {
    const roomId = generateRoomId();
    rooms.set(roomId, createRoomState());
    socket.pendingRoomId = roomId;
    socket.emit('room_created', { roomId });
  });

  // ── Join game (validate code before name entry) ───────────────────────
  socket.on('join_game', ({ roomId }) => {
    const id = String(roomId ?? '').trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) {
      return socket.emit('join_error', { message: `No game found with code "${id}". Double-check and try again.` });
    }
    if (room.phase === 'playing' || room.phase === 'reveal') {
      return socket.emit('join_error', { message: `Game ${id} is already in session. You snooze, you lose!` });
    }
    socket.pendingRoomId = id;
    socket.emit('join_game_ok', { roomId: id });
  });

  // ── Rejoin with session token ─────────
  socket.on('rejoin', ({ sessionToken }) => {
    const session = sessions[sessionToken];
    if (!session) { socket.emit('rejoin_failed'); return; }

    const { socketId: oldSocketId, roomId } = session;
    const room = rooms.get(roomId);
    if (!room) { delete sessions[sessionToken]; socket.emit('rejoin_failed'); return; }

    const idx = room.players.findIndex(p => p.id === oldSocketId);
    if (idx === -1) {
      delete sessions[sessionToken];
      socket.emit('rejoin_failed');
      return;
    }

    const player = room.players[idx];
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    sessions[sessionToken] = { socketId: socket.id, roomId };
    if (room.host === oldSocketId) room.host = socket.id;
    player.id = socket.id;
    player.connected = true;
    socket.playerName = player.name;
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);

    socket.emit('rejoined', {
      sessionToken,
      roomId,
      state: publicState(room),
      dice: player.dice,
      phase: room.phase
    });

    socket.to(roomId).emit('player_reconnected', {
      playerName: player.name,
      gameState: publicState(room)
    });
  });

  // ── Set name + join lobby ─────────────
  socket.on('set_name', ({ name }) => {
    const roomId = socket.pendingRoomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return socket.emit('join_error', { message: 'Room no longer exists.' });

    const n = String(name ?? '').trim().slice(0, 20);
    if (!n) return;

    if (room.phase === 'playing' || room.phase === 'reveal') {
      return socket.emit('join_error', { message: 'Game already started — you snooze, you lose!' });
    }

    let finalName = n;
    while (room.players.find(p => p.name === finalName)) finalName += '_';
    socket.playerName = finalName;

    const token = crypto.randomUUID();
    const player = { id: socket.id, name: finalName, diceCount: 5, dice: [], connected: true };
    sessions[token] = { socketId: socket.id, roomId };
    room.players.push(player);
    if (room.players.length === 1) room.host = socket.id;

    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);
    socket.pendingRoomId = null;

    socket.emit('joined_lobby', { ...publicState(room), sessionToken: token, roomId });
    socket.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Set game mode ─────────────────────
  socket.on('set_mode', ({ mode }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (!['standard', 'reverse'].includes(mode)) return;
    room.gameMode = mode;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Toggle variable mode ───────────────
  socket.on('set_variable', ({ value }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    room.isVariable = !!value;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Leave lobby individually ───────────
  socket.on('leave_lobby', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    Object.keys(sessions).forEach(t => {
      if (sessions[t].socketId === socket.id) delete sessions[t];
    });
    room.players.splice(idx, 1);
    socketToRoom.delete(socket.id);
    socket.leave(roomId);
    socket.emit('game_reset');
    if (room.players.length === 0) {
      rooms.delete(roomId);
    } else {
      if (room.host === socket.id) room.host = room.players[0].id;
      io.to(roomId).emit('lobby_update', publicState(room));
    }
  });

  // ── Start game ────────────────────────
  socket.on('start_game', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (!room.players.find(p => p.id === socket.id)) return;
    purgeDead(room);
    if (room.players.length < 2) return socket.emit('start_error', { message: 'Need at least 2 players to start.' });

    const startDice = room.gameMode === 'reverse' ? 1 : 5;
    room.players.forEach((p, i) => { p.diceCount = startDice; p.dice = []; p.colorIndex = i; });
    room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
    room.roundNumber = 1;
    room.palificoTriggerPlayer = null;
    startRound(room, roomId);
  });

  // ── Make bid ──────────────────────────
  socket.on('make_bid', ({ quantity, face }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return;

    const qty = parseInt(quantity, 10);
    const f   = parseInt(face, 10);
    const check = validateBid(qty, f, room);
    if (!check.valid) return socket.emit('bid_error', { message: check.reason });

    if (room.isPalifico && room.firstBidOfRound) {
      room.palificoFace = f;
    } else if (room.isPalifico && cp.diceCount === 1 && f !== room.palificoFace) {
      room.palificoFace = f;
    }

    room.lastBidderIndex    = room.currentPlayerIndex;
    room.currentBid         = { quantity: qty, face: room.isFaceoff ? null : f };
    room.firstBidOfRound    = false;
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;

    io.to(roomId).emit('bid_made', { bid: room.currentBid, bidderName: cp.name, gameState: publicState(room) });

    if (room.autoLiarPlayerId) {
      const newCurrent = room.players[room.currentPlayerIndex];
      if (newCurrent?.id === room.autoLiarPlayerId) {
        room.autoLiarPlayerId = null;
        setImmediate(() => processChallenge(newCurrent, room, roomId));
      }
    }
  });

  // ── Auto-liar ─────────────────────────
  socket.on('auto_liar', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    if (room.players[room.currentPlayerIndex]?.id === socket.id) return;
    if (room.autoLiarPlayerId === socket.id) return;
    room.autoLiarPlayerId = socket.id;
    io.to(roomId).emit('auto_liar_update', { playerId: socket.id, playerName: p.name, active: true });
  });

  // ── Challenge (Liar) ──────────────────
  socket.on('challenge', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing' || room.firstBidOfRound) return;
    const challenger = room.players[room.currentPlayerIndex];
    if (!challenger || challenger.id !== socket.id) return;
    processChallenge(challenger, room, roomId);
  });

  // ── Rage quit ─────────────────────────
  socket.on('rage_quit', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing' && room.phase !== 'reveal') return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const player = room.players[idx];
    room.players.splice(idx, 1);
    room.phase = 'over';
    io.to(roomId).emit('game_over', {
      winner:      room.players[0]?.name ?? 'Nobody',
      reason:      'rage_quit',
      quitterName: player.name
    });
  });

  // ── Next round ────────────────────────
  socket.on('next_round', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'reveal' || !room.revealResolved) return;
    if (!room.players.find(p => p.id === socket.id)) return;
    room.revealResolved = false;
    startRound(room, roomId);
  });

  // ── Reactions ─────────────────────────
  socket.on('reaction', ({ type }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { roomId } = ctx;
    if (!['fire', 'ice'].includes(type)) return;
    io.to(roomId).emit('reaction', { type });
  });

  // ── Leave room (back to landing) ──────
  socket.on('leave_room', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;

    if (room.phase !== 'over' && !room.players.find(p => p.id === socket.id)) return;
    io.to(roomId).emit('game_reset');

    Object.keys(sessions).forEach(t => {
      if (sessions[t].roomId === roomId) delete sessions[t];
    });
    room.players.forEach(p => {
      if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
      socketToRoom.delete(p.id);
    });
    rooms.delete(roomId);
  });

  // ── Kick player (host only) ───────────
  socket.on('kick_player', ({ playerId }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (socket.id !== room.host) return;

    const idx = room.players.findIndex(p => p.id === playerId && !p.connected);
    if (idx === -1) return;

    const player = room.players[idx];
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }

    room.players.splice(idx, 1);
    socketToRoom.delete(playerId);
    for (const t of Object.keys(sessions)) {
      if (sessions[t].socketId === playerId) { delete sessions[t]; break; }
    }

    if (room.phase === 'lobby' || room.phase === 'over') {
      if (room.host === playerId && room.players.length > 0) room.host = room.players[0].id;
      io.to(roomId).emit('lobby_update', publicState(room));
      if (room.players.length === 0) rooms.delete(roomId);
      return;
    }

    io.to(roomId).emit('player_eliminated', { playerId, playerName: player.name, reason: 'kick' });

    if (room.players.length <= 1) {
      room.phase = 'over';
      io.to(roomId).emit('game_over', { winner: room.players[0]?.name ?? 'Nobody' });
      return;
    }

    if (room.currentPlayerIndex >= room.players.length) room.currentPlayerIndex = 0;
    setTimeout(() => startRound(room, roomId), 500);
  });

  // ── Disconnect ────────────────────────
  socket.on('disconnect', () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) {
      if (socket.pendingRoomId) {
        const pendingRoom = rooms.get(socket.pendingRoomId);
        if (pendingRoom && pendingRoom.players.length === 0) rooms.delete(socket.pendingRoomId);
      }
      return;
    }
    const room = rooms.get(roomId);
    if (!room) { socketToRoom.delete(socket.id); return; }

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) { socketToRoom.delete(socket.id); return; }

    const player = room.players[idx];
    player.connected = false;

    if (room.phase === 'lobby' || room.phase === 'over') {
      io.to(roomId).emit('lobby_update', publicState(room));

      player.disconnectTimer = setTimeout(() => {
        const stillIdx = room.players.findIndex(p => p.id === socket.id);
        if (stillIdx === -1 || room.players[stillIdx].connected) return;

        const wasHost = room.host === socket.id;
        room.players.splice(stillIdx, 1);
        socketToRoom.delete(socket.id);
        if (wasHost && room.players.length > 0) room.host = room.players[0].id;
        io.to(roomId).emit('lobby_update', publicState(room));
        if (room.players.length === 0) rooms.delete(roomId);
      }, 60000);
    } else {
      io.to(roomId).emit('player_disconnected', { playerName: player.name, gameState: publicState(room) });
      // No auto-elimination timer — host can kick disconnected players manually
    }
  });
});

server.listen(PORT, () => console.log(`Perudo running on port ${PORT}`));
