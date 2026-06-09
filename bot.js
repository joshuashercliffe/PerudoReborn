'use strict';

const { io } = require('socket.io-client');

const roomCode = (process.argv[2] ?? '').toUpperCase();
const botName  = process.argv[3] ?? 'Bot';

if (!roomCode) {
  console.error('Usage: node bot.js <ROOM_CODE> [NAME]');
  process.exit(1);
}

const socket = io('http://localhost:3000');

let myId        = null;
let gameState   = null;
let turnPending = false;

function log(msg) {
  console.log(`[${botName}] ${msg}`);
}

function nextBid(gs) {
  const cur = gs.currentBid;

  if (gs.isFaceoff) {
    return { quantity: cur ? cur.quantity + 1 : 2, face: 0 };
  }

  if (!cur) {
    return { quantity: 1, face: 2 };
  }

  // Same face, one more — handles 1s and regular faces identically
  return { quantity: cur.quantity + 1, face: cur.face };
}

function takeTurn() {
  if (!gameState || gameState.currentPlayerId !== myId) return;
  if (gameState.phase !== 'playing') return;
  if (turnPending) return;

  turnPending = true;
  const bid = nextBid(gameState);

  setTimeout(() => {
    log(`bidding ${bid.quantity} × face ${bid.face === 0 ? '(sum)' : bid.face}`);
    socket.emit('make_bid', { quantity: bid.quantity, face: bid.face });
    turnPending = false;
  }, 800);
}

socket.on('connect', () => {
  myId = socket.id;
  log(`connected (${myId}), joining room ${roomCode}`);
  socket.emit('join_game', { roomId: roomCode });
});

socket.on('join_game_ok', () => {
  socket.emit('set_name', { name: botName });
});

socket.on('join_error', ({ message }) => {
  log(`failed to join: ${message}`);
  process.exit(1);
});

socket.on('name_error', ({ message }) => {
  log(`name rejected: ${message}`);
  process.exit(1);
});

socket.on('joined_lobby', state => {
  log(`in lobby — waiting for game to start`);
  gameState = state;
});

socket.on('lobby_update', state => {
  gameState = state;
});

socket.on('round_start', state => {
  log(`round ${state.roundNumber} started`);
  gameState   = state;
  turnPending = false;
  takeTurn();
});

socket.on('your_dice', ({ dice }) => {
  log(`my dice: [${dice.join(', ')}]`);
});

socket.on('bid_made', ({ bid, bidderName, gameState: state }) => {
  gameState   = state;
  turnPending = false;
  if (bidderName !== botName) {
    log(`${bidderName} bid ${bid.quantity} × ${bid.face === null ? 'sum' : bid.face}`);
  }
  takeTurn();
});

socket.on('bid_error', ({ message }) => {
  log(`bid error: ${message}`);
  turnPending = false;
});

socket.on('liar_called', ({ challengerName }) => {
  log(`${challengerName} called liar`);
  turnPending = false;
});

socket.on('challenge_result', () => { turnPending = false; });

socket.on('player_eliminated', ({ playerName }) => {
  log(`${playerName} eliminated`);
  if (playerName === botName) {
    log('I was eliminated — exiting');
    process.exit(0);
  }
});

socket.on('game_over', ({ winner }) => {
  log(`game over — winner: ${winner}`);
  process.exit(0);
});

socket.on('game_reset', () => process.exit(0));

socket.on('disconnect', () => {
  log('disconnected');
  process.exit(0);
});
