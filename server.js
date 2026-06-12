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

const { execSync } = require('child_process');
const deployedAt   = new Date().toISOString();
let   buildNumber  = 'dev';
try { buildNumber = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch (_) {}

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
}));

app.get('/version', (_req, res) => res.json({ build: buildNumber, deployedAt }));

// ─────────────────────────────────────────
// Multi-room state
// ─────────────────────────────────────────

const rooms        = new Map(); // roomId -> roomState
const socketToRoom = new Map(); // socketId -> roomId
const sessions     = {};        // sessionToken -> { socketId, roomId }

const ROOM_WORDS = [
  'ACE','AGE','ALE','ANT','APE','ARC','ARM','ART','ASH','AXE',
  'BAD','BAG','BAN','BAR','BAT','BED','BEE','BET','BUD','BUG','BUN','BUS','BUT',
  'CAB','CAN','CAP','CAR','CAT','CUB','CUP','CUT',
  'DAD','DAM','DEN',
  'EAR','EAT','EGG','ELK','ELM',
  'FAN','FAR','FAT','FED','FEW','FUR',
  'GAP','GAS','GEM','GUN','GUT','GUY',
  'HAM','HAT','HAY','HEN','HEX','HUB','HUG','HUT',
  'JAB','JAM','JAR','JAW','JET','JUG',
  'KEG','KEY',
  'LAD','LAP','LAW','LAX','LAY','LED','LEG',
  'MAD','MAP','MAT','MAY','MEN','MET','MUD','MUG',
  'NAP','NET','NEW','NUT',
  'PAN','PAR','PAT','PAW','PAY','PEA','PEG','PEN','PET','PUB','PUN','PUT',
  'RAG','RAM','RAN','RAP','RAT','RAW','RAY','RED','RUG','RUM','RUN','RUT',
  'SAD','SAP','SAT','SAW','SAY','SEA','SET','SEW','SUB','SUM','SUN',
  'TAB','TAN','TAP','TAR','TAX','TEA','TEN','TUB','TUG',
  'VAN','VAT','VET','VEX',
  'WAR','WAX','WAY','WEB','WED','WET',
  'YAK','YAM','YEA','YES','YET','YEW',
  'ZAP','ZED','ZEN'
];
const ROOM_DIGITS = '23456789';
const ITEM_POOL   = ['peek','scout','reroll','wild','shield','swap','skip','fakepips'];
const MAX_ITEMS   = 2; // inventory cap; gaining a 3rd discards the oldest

function randomItem() { return ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)]; }
function grantItem(player, type) {
  if (!player.items) player.items = [];
  player.items.push(type);
  while (player.items.length > MAX_ITEMS) player.items.shift(); // FIFO: drop oldest
  return type;
}
function removeItem(player, type) {
  const i = player.items ? player.items.indexOf(type) : -1;
  if (i >= 0) player.items.splice(i, 1);
}

function generateRoomId() {
  let id;
  do {
    const word  = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
    const digit = ROOM_DIGITS[Math.floor(Math.random() * ROOM_DIGITS.length)];
    id = Math.random() < 0.5 ? word + digit : digit + word;
  } while (rooms.has(id) || id === 'TEST');
  return id;
}

function createRoomState() {
  return {
    phase: 'lobby',
    gameMode: 'standard',
    isVariable: false,
    isInPerson: false,
    calzaEnabled: false,
    revealRerollEnabled: false,
    itemsEnabled: false,
    nextRoundReady: [],
    pendingIPChallenge: null,
    players: [],
    host: null,
    currentPlayerIndex: 0,
    lastBidderIndex: -1,
    currentBid: null,
    firstBidOfRound: true,
    bidCount: 0,
    isPalifico: false,
    isFaceoff: false,
    palificoFace: null,
    palificoTriggerPlayer: null,
    roundNumber: 0,
    revealResolved: false,
    autoLiarPlayerId: null,
    autoBidPlayerId: null
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
      connected: p.connected, colorIndex: p.colorIndex ?? 0,
      revealedDice: p.revealedDice ?? [],
      itemCount: (p.items?.length || 0), shieldActive: !!p.shieldActive, wildActive: !!p.wildActive,
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
    isInPerson:         room.isInPerson,
    calzaEnabled:       room.calzaEnabled,
    revealRerollEnabled: room.revealRerollEnabled,
    itemsEnabled:       room.itemsEnabled,
    autoLiarPlayerId:   room.autoLiarPlayerId,
    autoBidPlayerId:    room.autoBidPlayerId
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
  room.bidCount = 0;
  room.lastBidderIndex = -1;
  room.revealResolved = false;
  room.nextRoundReady = [];
  room.pendingIPChallenge = null;
  room.autoBidPlayerId = null;

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

  room.players.forEach((p) => {
    p.revealedDice = []; p.dice = roll(p.diceCount);
    if (!p.items) p.items = []; // items carry over between rounds; earned via Double Down
    p.wildActive = false; p.fakePip = null; p.shieldActive = false; p.shieldArmedAt = null; p.doubleDownBid = false; p.scoutedFace = null; p.pranked = false;
  });

  io.to(roomId).emit('round_start', publicState(room));
  room.players.forEach(p => { io.to(p.id).emit('your_dice', { dice: p.dice, revealedCount: 0, items: p.items }); });
}

// ─────────────────────────────────────────
// Challenge processing
// ─────────────────────────────────────────

// Tally the matching dice for a bid (face matches + 1s as wild unless Palifico;
// Faceoff totals the dice sum). Returns the per-player reveal payload and count.
function tallyBid(room, bid) {
  let count = 0;
  const revealedDice = room.players.map(p => {
    const pd = {
      id: p.id, name: p.name, dice: [...p.dice], colorIndex: p.colorIndex ?? 0,
      fakePip: p.fakePip ?? null, wildActive: p.wildActive ?? false,
    };
    if (room.isFaceoff) {
      count += p.dice.reduce((s, d) => s + d, 0);
    } else {
      p.dice.forEach(d => {
        if (room.isPalifico) { if (d === bid.face) count++; }
        else                 { if (d === bid.face || d === 1) count++; }
      });
      if (p.wildActive) count++; // Wild: one guaranteed die always counts toward any bid
    }
    return pd;
  });
  return { revealedDice, count };
}

function processChallenge(challenger, room, roomId) {
  const bidder = room.players[room.lastBidderIndex];
  if (!bidder) return;

  room.phase = 'reveal';

  const allDice = room.players.flatMap(p => p.dice);
  const isPeak  = checkIsPeak(room.currentBid, allDice, room, challenger);

  io.to(roomId).emit('liar_called', { challengerName: challenger.name, isPeak });

  const bid = room.currentBid;
  const { revealedDice, count } = tallyBid(room, bid);

  const bidMet = count >= bid.quantity;
  const loser  = bidMet ? challenger : bidder;

  let rawDelta = (room.isVariable && !room.isFaceoff)
    ? (bidMet ? count - bid.quantity + 1 : bid.quantity - count)
    : 1;

  // Double Down: the BIDDER staked their bid. If their bid was wrong (they
  // lose), the penalty doubles. If their bid was right (challenger loses),
  // the bidder earns a random power-up instead.
  const doubleDownActive = !!bidder.doubleDownBid;
  if (doubleDownActive && loser.id === bidder.id) rawDelta *= 2;

  let diceDelta = Math.min(rawDelta, loser.diceCount);

  const shieldAbsorbed = !!loser.shieldActive;
  if (shieldAbsorbed) { diceDelta = 0; loser.shieldActive = false; }

  let earnedItem = null;
  if (doubleDownActive && bidMet && room.itemsEnabled) {
    earnedItem = grantItem(bidder, randomItem());
  }
  if (doubleDownActive) bidder.doubleDownBid = false;

  const result = {
    revealedDice, bid, count, bidMet,
    isPeak, diceDelta, doubleDownActive, shieldAbsorbed,
    earnedItem, earnedBy: earnedItem ? bidder.name : null,
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

// Calza (exact call): the current player bets the bid count is exactly right.
// Correct → caller wins a die back; wrong → caller loses one. Caller starts next round.
function processCalza(caller, room, roomId) {
  if (!room.currentBid) return;
  room.phase = 'reveal';

  const bid = room.currentBid;
  const { revealedDice, count } = tallyBid(room, bid);
  const exact = count === bid.quantity;

  const shieldAbsorbed = !exact && !!caller.shieldActive;
  if (shieldAbsorbed) caller.shieldActive = false;

  io.to(roomId).emit('calza_called', { callerName: caller.name });

  const result = {
    calza: true, exact,
    revealedDice, bid, count, diceDelta: shieldAbsorbed ? 0 : 1,
    shieldAbsorbed,
    isPalifico: room.isPalifico,
    isFaceoff:  room.isFaceoff,
    gameMode:   room.gameMode,
    callerName: caller.name,
    callerId:   caller.id
  };

  setTimeout(() => {
    io.to(roomId).emit('challenge_result', result);

    setTimeout(() => {
      const callerIdx = room.players.findIndex(p => p.id === caller.id);
      if (callerIdx === -1) {
        if (room.phase !== 'over') {
          room.roundNumber++;
          room.revealResolved = true;
          io.to(roomId).emit('reveal_resolved');
        }
        return;
      }

      const cp      = room.players[callerIdx];
      const reverse = room.gameMode === 'reverse';

      // exact → reward (good); wrong → penalty (bad). Direction flips in reverse mode.
      if (exact) {
        cp.diceCount = reverse ? Math.max(1, cp.diceCount - 1) : Math.min(5, cp.diceCount + 1);
        room.currentPlayerIndex = callerIdx;
        if (!reverse && cp.diceCount === 1) room.palificoTriggerPlayer = cp.id;
      } else if (result.shieldAbsorbed) {
        room.currentPlayerIndex = callerIdx; // no die change — shield absorbed the loss
      } else {
        cp.diceCount += reverse ? 1 : -1;
        const eliminated = reverse ? cp.diceCount > 5 : cp.diceCount <= 0;

        if (eliminated) {
          cp.diceCount = 0;
          cp.dice = [];
          if (room.autoLiarPlayerId === cp.id) room.autoLiarPlayerId = null;

          io.to(roomId).emit('player_eliminated', { playerId: cp.id, playerName: cp.name });
          room.players.splice(callerIdx, 1);

          if (room.players.length === 1) {
            room.phase = 'over';
            io.to(roomId).emit('game_over', { winner: room.players[0].name });
            return;
          }
          if (!reverse) room.palificoTriggerPlayer = null;
          room.currentPlayerIndex = callerIdx % room.players.length;
        } else {
          room.currentPlayerIndex = callerIdx;
          if (!reverse && cp.diceCount === 1) room.palificoTriggerPlayer = cp.id;
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

function broadcastStats() {
  let players = 0;
  for (const room of rooms.values()) players += room.players.filter(p => p.connected).length;
  io.emit('server_stats', { games: rooms.size, players });
}

io.on('connection', socket => {
  // Send current stats to newly connected client
  { let players = 0; for (const room of rooms.values()) players += room.players.filter(p => p.connected).length;
    socket.emit('server_stats', { games: rooms.size, players }); }

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
    broadcastStats();
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
      revealedCount: player.revealedDice?.length ?? 0,
      pranked: !!player.pranked,
      items: player.items ?? [],
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
    const player = { id: socket.id, name: finalName, diceCount: 5, dice: [], revealedDice: [], connected: true };
    sessions[token] = { socketId: socket.id, roomId };
    room.players.push(player);
    if (room.players.length === 1) room.host = socket.id;

    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);
    socket.pendingRoomId = null;

    socket.emit('joined_lobby', { ...publicState(room), sessionToken: token, roomId });
    socket.to(roomId).emit('lobby_update', publicState(room));
    broadcastStats();
  });

  // ── Set game mode ─────────────────────
  socket.on('set_mode', ({ mode }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    if (!['standard', 'reverse'].includes(mode)) return;
    room.gameMode = mode;
    // Reveal & Reroll is Standard-only — clear it if the host leaves Standard.
    if (mode !== 'standard') room.revealRerollEnabled = false;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Toggle variable mode ───────────────
  socket.on('set_variable', ({ value }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    room.isVariable = !!value;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Toggle in-person mode ──────────────
  socket.on('set_inperson', ({ value }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    room.isInPerson = !!value;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Toggle Calza (exact call) ──────────
  socket.on('set_calza', ({ value }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    room.calzaEnabled = !!value;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Toggle Items (one power-up per player per round) ──
  socket.on('set_items', ({ value }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    room.itemsEnabled = !!value;
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Toggle Reveal & Reroll (Standard only) ──
  socket.on('set_reveal_reroll', ({ value }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    room.revealRerollEnabled = !!value && room.gameMode === 'standard';
    io.to(roomId).emit('lobby_update', publicState(room));
  });

  // ── Reorder players (seating) ──────────
  socket.on('reorder_players', ({ order }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'lobby') return;
    if (socket.id !== room.host) return;
    if (!Array.isArray(order) || order.length !== room.players.length) return;
    const playerMap = new Map(room.players.map(p => [p.id, p]));
    const reordered = order.map(id => playerMap.get(id)).filter(Boolean);
    if (reordered.length !== room.players.length) return;
    room.players = reordered;
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
    if (socket.id !== room.host) return socket.emit('start_error', { message: 'Only the host can start the game.' });
    purgeDead(room);
    if (room.players.length < 2) return socket.emit('start_error', { message: 'Need at least 2 players to start.' });

    const startDice = room.gameMode === 'reverse' ? 1 : 5;
    room.players.forEach((p, i) => {
      p.diceCount = startDice; p.dice = []; p.revealedDice = []; p.colorIndex = i;
      p.items = room.itemsEnabled ? [randomItem()] : []; // one free power-up at game start only
      p.wildActive = false; p.fakePip = null; p.shieldActive = false; p.shieldArmedAt = null; p.doubleDownBid = false; p.scoutedFace = null; p.pranked = false;
    });
    room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
    room.roundNumber = 1;
    room.palificoTriggerPlayer = null;
    startRound(room, roomId);
  });

  // ── Make bid ──────────────────────────
  socket.on('make_bid', ({ quantity, face, reveal, doubleDown }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return;

    const qty = parseInt(quantity, 10);
    const f   = parseInt(face, 10);
    const check = validateBid(qty, f, room);
    if (!check.valid) return socket.emit('bid_error', { message: check.reason });

    // Scout restriction: you can't bid the face you scouted this round
    // (skipped in palifico/faceoff, where face choice is constrained/absent).
    if (!room.isFaceoff && !room.isPalifico && cp.scoutedFace && f === cp.scoutedFace) {
      return socket.emit('bid_error', { message: `You scouted ${f}s — you can't bid them this round.` });
    }

    if (room.isPalifico && room.firstBidOfRound) {
      room.palificoFace = f;
    } else if (room.isPalifico && cp.diceCount === 1 && f !== room.palificoFace) {
      room.palificoFace = f;
    }

    // Reveal & Reroll (Standard, opt-in): reveal chosen secret dice, reroll the rest.
    let revealed = [];
    if (room.revealRerollEnabled && room.gameMode === 'standard' && !room.isInPerson && Array.isArray(reveal) && reveal.length) {
      const lockedCount = cp.revealedDice.length;
      const secretDice  = cp.dice.slice(lockedCount);
      const idxs = [...new Set(reveal.map(Number))].filter(i => Number.isInteger(i) && i >= 0 && i < secretDice.length);
      if (idxs.length) {
        revealed = idxs.map(i => secretDice[i]);
        const rest = secretDice.filter((_, i) => !idxs.includes(i));
        cp.revealedDice = cp.revealedDice.concat(revealed);
        cp.dice = cp.revealedDice.concat(roll(rest.length));
      }
    }

    // A new bid supersedes the standing bid, so any shield armed against an
    // earlier bid window now expires — shields only cover a single bid. A prior
    // Double Down bid is also superseded (it only pays out if challenged).
    room.players.forEach(pl => {
      if (pl.shieldActive && pl.shieldArmedAt != null && pl.shieldArmedAt <= room.bidCount) {
        pl.shieldActive = false; pl.shieldArmedAt = null;
      }
      pl.doubleDownBid = false;
    });
    room.bidCount = (room.bidCount || 0) + 1;

    room.lastBidderIndex    = room.currentPlayerIndex;
    room.currentBid         = { quantity: qty, face: room.isFaceoff ? null : f };
    room.firstBidOfRound    = false;
    // Double Down: stake this bid. If challenged and wrong → lose 2 dice;
    // if challenged and right → earn a random power-up. Requires items on.
    if (doubleDown && room.itemsEnabled) cp.doubleDownBid = true;
    if (room.autoBidPlayerId === socket.id) room.autoBidPlayerId = null;
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;

    io.to(roomId).emit('bid_made', { bid: room.currentBid, bidderName: cp.name, revealed, gameState: publicState(room) });

    if (revealed.length) {
      io.to(cp.id).emit('your_dice', { dice: cp.dice, revealedCount: cp.revealedDice.length });
    }

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

  socket.on('lock_autobid', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing') return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    if (room.players[room.currentPlayerIndex]?.id === socket.id) return;
    room.autoBidPlayerId = socket.id;
    io.to(roomId).emit('autobid_update', { playerId: socket.id, playerName: p.name });
  });

  // ── Challenge (Liar) ──────────────────
  socket.on('challenge', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing' || room.firstBidOfRound) return;
    const challenger = room.players[room.currentPlayerIndex];
    if (!challenger || challenger.id !== socket.id) return;
    // Scout restriction: you can't call Liar on the face you scouted this round.
    if (!room.isFaceoff && !room.isPalifico && challenger.scoutedFace &&
        room.currentBid && room.currentBid.face === challenger.scoutedFace) {
      return socket.emit('bid_error', { message: `You scouted ${challenger.scoutedFace}s — you can't call Liar on this bid.` });
    }
    processChallenge(challenger, room, roomId);
  });

  // ── Calza (exact call) ────────────────
  socket.on('calza', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing' || room.firstBidOfRound) return;
    if (!room.calzaEnabled || room.isInPerson || !room.currentBid) return;
    const caller = room.players[room.currentPlayerIndex];
    if (!caller || caller.id !== socket.id) return;
    // Scout restriction: you can't Calza the face you scouted this round.
    if (!room.isFaceoff && !room.isPalifico && caller.scoutedFace &&
        room.currentBid.face === caller.scoutedFace) {
      return socket.emit('bid_error', { message: `You scouted ${caller.scoutedFace}s — you can't Calza this bid.` });
    }
    processCalza(caller, room, roomId);
  });

  // ── Use item ─────────────────────────
  socket.on('use_item', (payload) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (room.phase !== 'playing') return;
    const player = room.players.find(pl => pl.id === socket.id);
    if (!player) return;
    const { itemType } = payload ?? {};
    if (!player.items || !player.items.includes(itemType)) return;
    const isCurrent = room.players[room.currentPlayerIndex]?.id === socket.id;
    const emit = (extra = {}) => io.to(roomId).emit('item_used', { playerId: socket.id, playerName: player.name, itemType, ...extra, gameState: publicState(room) });

    switch (itemType) {
      case 'peek': {
        if (!isCurrent) return;
        const t = room.players.find(p => p.id === payload.targetId);
        if (!t || t.id === socket.id || !t.dice.length) return;
        // Reveal half the target's dice (rounded down), but always at least one.
        const howMany = Math.max(1, Math.floor(t.dice.length / 2));
        const idxs = [...t.dice.keys()].sort(() => Math.random() - 0.5).slice(0, howMany);
        const faces = idxs.map(i => t.dice[i]);
        removeItem(player, itemType);
        io.to(socket.id).emit('item_result', { itemType: 'peek', targetName: t.name, faces });
        emit({ targetName: t.name });
        break;
      }
      case 'scout': {
        if (!isCurrent) return;
        const face = parseInt(payload.face, 10);
        if (!Number.isInteger(face) || face < 2 || face > 6) return; // can't scout 1s
        let scoutCount = 0;
        room.players.forEach(p => p.dice.forEach(d => { if (d === face) scoutCount++; }));
        removeItem(player, itemType);
        player.scoutedFace = face; // can't bid or call Liar on this face this round
        io.to(socket.id).emit('item_result', { itemType: 'scout', face, count: scoutCount });
        emit();
        break;
      }
      case 'reroll': {
        if (!isCurrent) return;
        const idxs = [...new Set((Array.isArray(payload.indices) ? payload.indices : []).map(Number)
          .filter(i => Number.isInteger(i) && i >= 0 && i < player.dice.length))].slice(0, 2);
        if (!idxs.length) return;
        idxs.forEach(i => { player.dice[i] = roll(1)[0]; });
        removeItem(player, itemType);
        io.to(socket.id).emit('your_dice', { dice: player.dice, revealedCount: player.revealedDice.length });
        emit();
        break;
      }
      case 'wild': {
        if (!isCurrent || room.isFaceoff) return;
        player.wildActive = true;
        removeItem(player, itemType);
        emit();
        break;
      }
      case 'shield': {
        // Shield only protects against the standing bid's resolution. It stays
        // armed until that bid is superseded by a new one (see make_bid).
        if (!room.currentBid) return;
        player.shieldActive = true;
        player.shieldArmedAt = room.bidCount;
        removeItem(player, itemType);
        emit();
        break;
      }
      case 'swap': {
        if (!isCurrent) return;
        const st = room.players.find(p => p.id === payload.targetId);
        if (!st || st.id === socket.id) return;
        const tmpCount = st.diceCount;
        st.diceCount = player.diceCount;
        player.diceCount = tmpCount;
        player.dice = roll(player.diceCount);
        st.dice = roll(st.diceCount);
        player.revealedDice = []; st.revealedDice = [];
        removeItem(player, itemType);
        io.to(socket.id).emit('your_dice', { dice: player.dice, revealedCount: 0 });
        io.to(st.id).emit('your_dice', { dice: st.dice, revealedCount: 0 });
        emit({ targetName: st.name });
        break;
      }
      case 'skip': {
        if (!isCurrent) return;
        removeItem(player, itemType);
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
        if (room.autoBidPlayerId === socket.id) room.autoBidPlayerId = null;
        emit();
        if (room.autoLiarPlayerId && !room.firstBidOfRound) {
          const nc = room.players[room.currentPlayerIndex];
          if (nc?.id === room.autoLiarPlayerId) {
            room.autoLiarPlayerId = null;
            setImmediate(() => processChallenge(nc, room, roomId));
          }
        }
        break;
      }
      case 'fakepips': {
        if (!isCurrent) return;
        const ft = room.players.find(p => p.id === payload.targetId);
        if (!ft || ft.id === socket.id || !ft.dice.length) return;
        removeItem(player, itemType);
        ft.pranked = true; // for reconnect re-sync
        // Cosmetic prank: stamp a big black pip over the victim's own dice so
        // they misread their hand. Real values are untouched; truth shows at reveal.
        io.to(ft.id).emit('fake_pips_drawn', { by: player.name });
        emit(); // public toast names the user, not the victim
        break;
      }
    }
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
    if (room.nextRoundReady.includes(socket.id)) return;

    room.nextRoundReady.push(socket.id);

    const connectedIds = room.players.filter(p => p.connected).map(p => p.id);
    const allReady = connectedIds.every(id => room.nextRoundReady.includes(id));
    if (allReady) startRound(room, roomId);
  });

  // ── In-person: liar call ──────────────
  socket.on('ip_challenge', ({ qty, face, accusedId }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (!room.isInPerson || room.phase !== 'playing') return;
    if (room.pendingIPChallenge) return;
    const challenger = room.players.find(p => p.id === socket.id);
    if (!challenger) return;
    const accused = room.players.find(p => p.id === accusedId);
    if (!accused || accused.id === challenger.id) return;
    const q = parseInt(qty, 10);
    const f = room.isFaceoff ? null : parseInt(face, 10);
    if (!Number.isInteger(q) || q < 1) return;
    if (!room.isFaceoff && (!Number.isInteger(f) || f < 1 || f > 6)) return;
    room.pendingIPChallenge = { challengerId: challenger.id, challengerName: challenger.name, accusedId: accused.id, accusedName: accused.name, qty: q, face: f };
    io.to(accused.id).emit('ip_confirm_request', { challengerName: challenger.name, qty: q, face: f });
    io.to(roomId).emit('ip_challenge_pending', { challengerName: challenger.name, accusedName: accused.name, qty: q, face: f });
  });

  // ── In-person: accused confirms bid ───
  socket.on('ip_confirm', ({ qty, face }) => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (!room.pendingIPChallenge || socket.id !== room.pendingIPChallenge.accusedId) return;
    const { challengerId, accusedId } = room.pendingIPChallenge;
    const q = parseInt(qty, 10);
    const f = room.isFaceoff ? null : parseInt(face, 10);
    if (!Number.isInteger(q) || q < 1) return;
    if (!room.isFaceoff && (!Number.isInteger(f) || f < 1 || f > 6)) return;
    room.currentBid = { quantity: q, face: f };
    room.lastBidderIndex = room.players.findIndex(p => p.id === accusedId);
    const challenger = room.players.find(p => p.id === challengerId);
    room.pendingIPChallenge = null;
    if (!challenger || room.lastBidderIndex === -1) return;
    processChallenge(challenger, room, roomId);
  });

  // ── In-person: cancel pending challenge
  socket.on('ip_cancel', () => {
    const ctx = getRoom(); if (!ctx) return;
    const { room, roomId } = ctx;
    if (!room.pendingIPChallenge) return;
    if (socket.id !== room.pendingIPChallenge.challengerId && socket.id !== room.pendingIPChallenge.accusedId) return;
    room.pendingIPChallenge = null;
    io.to(roomId).emit('ip_challenge_cancelled');
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
    broadcastStats();

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
        broadcastStats();
      }, 60000);
    } else {
      io.to(roomId).emit('player_disconnected', { playerName: player.name, gameState: publicState(room) });
      // No auto-elimination timer — host can kick disconnected players manually
    }
  });
});

server.listen(PORT, () => console.log(`Perudo running on port ${PORT}`));
