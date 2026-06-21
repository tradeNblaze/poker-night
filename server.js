const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWebSocketServer } = require('./ws-server.js');
const PE = require('./engine.js');
const { botDecide } = require('./bot-ai.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 9;
const MIN_PLAYERS = 2;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 30000;
const BOT_DELAY_MIN = 600, BOT_DELAY_MAX = 1100;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1

// ===================== ROOM STATE =====================
const rooms = new Map(); // code -> room

function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}
function genToken() { return crypto.randomBytes(12).toString('hex'); }

function createRoom() {
  const code = genRoomCode();
  const room = {
    code,
    players: [], // { seatIndex, name, isBot, token, connId, chips, isOut }
    settings: { chips: 1000, sb: 5, bb: 10 },
    phase: 'lobby', // lobby | playing
    game: null,
    pendingTimer: null, // {seatIndex, timer} for disconnect-grace or bot-delay
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function findPlayerBySeat(room, seatIndex) {
  return room.players.find(p => p.seatIndex === seatIndex);
}

function nextSeatIndex(room) {
  let i = 0;
  while (room.players.some(p => p.seatIndex === i)) i++;
  return i;
}

// ===================== CONNECTIONS =====================
let connCounter = 1;
const connections = new Map(); // connId -> { ws, roomCode, seatIndex, name }

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}
function sendError(ws, message) { send(ws, { type: 'error', message }); }

// ===================== SERIALIZATION =====================
function publicPlayerView(p) {
  const gp = currentGamePlayer(p);
  return {
    seatIndex: p.seatIndex,
    name: p.name,
    isBot: p.isBot,
    connected: p.isBot ? true : !!p.connId,
    chips: gp ? gp.chips : p.chips,
    contributionThisRound: gp ? gp.contributionThisRound : 0,
    folded: gp ? gp.folded : false,
    allIn: gp ? gp.allIn : false,
    isOut: gp ? gp.isOut : false,
  };
}

function currentGamePlayer(p) {
  // engine players are indexed by array position matching room.players order at game-start time;
  // we store the mapping via p.engineId set when game starts.
  return p._gp || null;
}

function buildPublicState(room) {
  const base = {
    type: 'state',
    roomCode: room.code,
    phase: room.phase,
    settings: room.settings,
    players: room.players.slice().sort((a, b) => a.seatIndex - b.seatIndex).map(publicPlayerView),
  };
  if (room.phase === 'lobby') return base;

  const g = room.game;
  base.handNumber = g.handNumber;
  base.stage = g.stage;
  base.dealerSeat = seatForEngineIndex(room, g.dealerIndex);
  base.sbSeat = seatForEngineIndex(room, g.sbIndex);
  base.bbSeat = seatForEngineIndex(room, g.bbIndex);
  base.currentSeat = g.stage === 'hand-over' ? null : seatForEngineIndex(room, g.currentPlayerIndex);
  base.pot = g.players.reduce((s, p) => s + p.totalContributionThisHand, 0);
  base.currentBet = g.currentBet;
  base.communityCards = g.communityCards;
  base.log = g.log;
  base.gameOver = g.gameOver;

  if (g.lastHandResult) {
    base.lastHandResult = {
      showdown: g.lastHandResult.showdown,
      winners: g.lastHandResult.winners.map(w => ({ seat: seatForEngineIndex(room, w.id), name: w.name, amount: w.amount })),
      hands: g.lastHandResult.hands.map(h => ({ seat: seatForEngineIndex(room, h.id), name: h.name, holeCards: h.holeCards, handName: h.handName })),
    };
  } else {
    base.lastHandResult = null;
  }
  return base;
}

function seatForEngineIndex(room, engineIdx) {
  if (engineIdx == null || engineIdx < 0) return null;
  const gp = room.game.players[engineIdx];
  return gp ? gp.id : null; // engine player id === seatIndex (we set id = seatIndex at game creation)
}

function buildYouState(room, player) {
  const you = { type: 'you', seatIndex: player.seatIndex, token: player.token, name: player.name };
  if (room.phase === 'playing') {
    const gp = currentGamePlayer(player);
    you.holeCards = gp ? gp.holeCards : [];
    you.validActions = null;
    if (gp && room.game.stage !== 'hand-over' && room.game.currentPlayerIndex === seatToEngineIndex(room, player.seatIndex)) {
      const va = PE.getValidActions(room.game);
      if (va) you.validActions = va;
    }
  } else {
    you.holeCards = [];
    you.validActions = null;
  }
  return you;
}

function seatToEngineIndex(room, seatIndex) {
  if (!room.game) return -1;
  return room.game.players.findIndex(gp => gp.id === seatIndex);
}

function broadcast(room) {
  room.lastActivity = Date.now();
  const pub = buildPublicState(room);
  for (const p of room.players) {
    if (p.isBot || !p.connId) continue;
    const conn = connections.get(p.connId);
    if (!conn) continue;
    send(conn.ws, pub);
    send(conn.ws, buildYouState(room, p));
  }
}

// ===================== GAME FLOW =====================
function startGame(room) {
  const seated = room.players.filter(p => !p.removed);
  const configs = seated.map(p => ({ id: p.seatIndex, name: p.name, isBot: p.isBot, chips: room.settings.chips }));
  const game = PE.createGame(configs, room.settings.sb, room.settings.bb);
  room.game = game;
  room.phase = 'playing';
  // link engine players back to room players for chip persistence/view
  for (const p of room.players) {
    p._gp = game.players.find(gp => gp.id === p.seatIndex) || null;
  }
  PE.startHand(game);
  syncChipsToRoomPlayers(room);
  broadcast(room);
  scheduleNextActorIfNeeded(room);
}

function syncChipsToRoomPlayers(room) {
  for (const p of room.players) {
    if (p._gp) p.chips = p._gp.chips;
  }
}

function clearPendingTimer(room) {
  if (room.pendingTimer) {
    clearTimeout(room.pendingTimer.timer);
    room.pendingTimer = null;
  }
}

function scheduleNextActorIfNeeded(room) {
  clearPendingTimer(room);
  const g = room.game;
  if (!g || g.stage === 'hand-over') return;
  const gp = g.players[g.currentPlayerIndex];
  if (!gp) return;
  const roomPlayer = findPlayerBySeat(room, gp.id);
  if (gp.isBot) {
    const timer = setTimeout(() => {
      if (!room.game || room.game.stage === 'hand-over') return;
      const action = botDecide(room.game);
      applyActionAndAdvance(room, action);
    }, BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN));
    room.pendingTimer = { seatIndex: gp.id, timer };
  } else if (roomPlayer && !roomPlayer.connId) {
    // disconnected human - grace period then auto-act
    const timer = setTimeout(() => {
      if (!room.game || room.game.stage === 'hand-over') return;
      const va = PE.getValidActions(room.game);
      if (!va) return;
      const action = va.canCheck ? { type: 'check' } : { type: 'fold' };
      applyActionAndAdvance(room, action);
    }, DISCONNECT_GRACE_MS);
    room.pendingTimer = { seatIndex: gp.id, timer };
  }
}

function applyActionAndAdvance(room, action) {
  PE.applyAction(room.game, action);
  syncChipsToRoomPlayers(room);
  broadcast(room);
  if (room.game.stage === 'hand-over') {
    clearPendingTimer(room);
  } else {
    scheduleNextActorIfNeeded(room);
  }
}

// ===================== MESSAGE HANDLERS =====================
function handleMessage(connId, raw) {
  const conn = connections.get(connId);
  if (!conn) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return sendError(conn.ws, 'Bad message'); }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'create_room': return onCreateRoom(connId, msg);
    case 'join_room': return onJoinRoom(connId, msg);
    case 'add_bot': return onAddBot(connId, msg);
    case 'remove_player': return onRemovePlayer(connId, msg);
    case 'update_settings': return onUpdateSettings(connId, msg);
    case 'start_game': return onStartGame(connId, msg);
    case 'action': return onAction(connId, msg);
    case 'next_hand': return onNextHand(connId, msg);
    case 'return_to_lobby': return onReturnToLobby(connId, msg);
    case 'leave_room': return onLeaveRoom(connId, msg);
    case 'ping': return; // keepalive no-op
  }
}

function onReturnToLobby(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'playing' || !room.game || !room.game.gameOver) return;
  clearPendingTimer(room);
  room.phase = 'lobby';
  room.game = null;
  room.players = room.players.filter(p => p.isBot || p.connId);
  for (const p of room.players) { p._gp = null; p.chips = 0; }
  broadcast(room);
}

function onCreateRoom(connId, msg) {
  const conn = connections.get(connId);
  const room = createRoom();
  const name = (msg.name || '').trim().slice(0, 18) || 'Player 1';
  const token = genToken();
  const player = { seatIndex: 0, name, isBot: false, token, connId, chips: 0, removed: false };
  room.players.push(player);
  conn.roomCode = room.code;
  conn.seatIndex = 0;
  send(conn.ws, { type: 'joined', roomCode: room.code, token, seatIndex: 0 });
  broadcast(room);
}

function onJoinRoom(connId, msg) {
  const conn = connections.get(connId);
  const code = (msg.roomCode || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(conn.ws, 'Room not found. Check the code and try again.');

  // reconnect path
  if (msg.token) {
    const existing = room.players.find(p => p.token === msg.token);
    if (existing) {
      existing.connId = connId;
      conn.roomCode = room.code;
      conn.seatIndex = existing.seatIndex;
      send(conn.ws, { type: 'joined', roomCode: room.code, token: existing.token, seatIndex: existing.seatIndex });
      clearPendingTimerIfMatches(room, existing.seatIndex); // they're back, cancel auto-fold grace timer for them specifically
      scheduleNextActorIfNeeded(room); // re-evaluate (might still be their turn, now connected -> no auto timer needed)
      broadcast(room);
      return;
    }
  }

  if (room.phase === 'playing') return sendError(conn.ws, 'This game already started. Ask the host for a new room.');
  const activeCount = room.players.filter(p => !p.removed).length;
  if (activeCount >= MAX_PLAYERS) return sendError(conn.ws, 'This table is full.');

  const name = (msg.name || '').trim().slice(0, 18) || ('Player ' + (activeCount + 1));
  const seatIndex = nextSeatIndex(room);
  const token = genToken();
  const player = { seatIndex, name, isBot: false, token, connId, chips: 0, removed: false };
  room.players.push(player);
  conn.roomCode = room.code;
  conn.seatIndex = seatIndex;
  send(conn.ws, { type: 'joined', roomCode: room.code, token, seatIndex });
  broadcast(room);
}

function clearPendingTimerIfMatches(room, seatIndex) {
  if (room.pendingTimer && room.pendingTimer.seatIndex === seatIndex && room.game) {
    const gp = room.game.players[room.game.currentPlayerIndex];
    if (gp && gp.id === seatIndex && !gp.isBot) {
      clearPendingTimer(room);
    }
  }
}

function onAddBot(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  const activeCount = room.players.filter(p => !p.removed).length;
  if (activeCount >= MAX_PLAYERS) return sendError(conn.ws, 'This table is full.');
  const seatIndex = nextSeatIndex(room);
  const botNames = ['Rex', 'Nova', 'Ace', 'Diesel', 'Lucky', 'Spark', 'Jett', 'Sable'];
  const name = 'Bot ' + botNames[seatIndex % botNames.length];
  room.players.push({ seatIndex, name, isBot: true, token: null, connId: null, chips: 0, removed: false });
  broadcast(room);
}

function onRemovePlayer(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  const target = findPlayerBySeat(room, msg.seatIndex);
  if (!target) return;
  room.players = room.players.filter(p => p.seatIndex !== msg.seatIndex);
  broadcast(room);
}

function onUpdateSettings(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  const s = msg.settings || {};
  if (Number.isFinite(s.chips) && s.chips >= 20) room.settings.chips = Math.floor(s.chips);
  if (Number.isFinite(s.sb) && s.sb >= 1) room.settings.sb = Math.floor(s.sb);
  if (Number.isFinite(s.bb) && s.bb >= 2 && s.bb > room.settings.sb) room.settings.bb = Math.floor(s.bb);
  broadcast(room);
}

function onStartGame(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'lobby') return;
  const activeCount = room.players.filter(p => !p.removed).length;
  if (activeCount < MIN_PLAYERS) return sendError(conn.ws, `Need at least ${MIN_PLAYERS} players to start.`);
  startGame(room);
}

function onAction(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'playing' || !room.game) return;
  const g = room.game;
  if (g.stage === 'hand-over') return;
  const engineIdx = seatToEngineIndex(room, conn.seatIndex);
  if (engineIdx !== g.currentPlayerIndex) return sendError(conn.ws, "It's not your turn.");
  const va = PE.getValidActions(g);
  if (!va) return;
  const action = msg.action || {};
  if (!['fold', 'check', 'call', 'bet', 'raise'].includes(action.type)) return;
  if (action.type === 'check' && !va.canCheck) return sendError(conn.ws, "You can't check right now.");
  if (action.type === 'call' && !va.canCall) return sendError(conn.ws, "You can't call right now.");
  if ((action.type === 'bet' || action.type === 'raise')) {
    if (!va.canRaise) return sendError(conn.ws, "You can't raise right now.");
    const amt = Number(action.amount);
    if (!Number.isFinite(amt)) return sendError(conn.ws, 'Invalid raise amount.');
    action.amount = Math.round(Math.max(va.minRaiseTo, Math.min(va.maxRaiseTo, amt)));
  }
  applyActionAndAdvance(room, action);
}

function onNextHand(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'playing' || !room.game) return;
  if (room.game.stage !== 'hand-over') return;
  if (room.game.gameOver) return; // nothing to deal; client should show final results
  PE.startHand(room.game);
  syncChipsToRoomPlayers(room);
  broadcast(room);
  scheduleNextActorIfNeeded(room);
}

function onLeaveRoom(connId) {
  const conn = connections.get(connId);
  if (!conn || !conn.roomCode) return;
  disconnectFromRoom(connId);
}

function disconnectFromRoom(connId) {
  const conn = connections.get(connId);
  if (!conn || !conn.roomCode) return;
  const room = rooms.get(conn.roomCode);
  if (!room) return;
  const player = findPlayerBySeat(room, conn.seatIndex);
  if (player) {
    player.connId = null;
    if (room.phase === 'lobby') {
      // in lobby, just remove them outright - no game state to preserve
      room.players = room.players.filter(p => p.seatIndex !== conn.seatIndex);
    } else {
      scheduleNextActorIfNeeded(room); // may start a grace timer if it's their turn
    }
  }
  broadcast(room);
  maybeCleanupRoom(room);
}

function maybeCleanupRoom(room) {
  const anyoneConnected = room.players.some(p => p.isBot || p.connId);
  if (!anyoneConnected) {
    clearPendingTimer(room);
    rooms.delete(room.code);
  }
}

// ===================== HTTP + STATIC FILES =====================
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = attachWebSocketServer(server, { path: '/ws' });

wss.on('connection', (ws) => {
  const connId = connCounter++;
  connections.set(connId, { ws, roomCode: null, seatIndex: null });

  ws.on('message', (raw) => handleMessage(connId, raw));
  ws.on('close', () => {
    disconnectFromRoom(connId);
    connections.delete(connId);
  });
});

// periodic cleanup of fully-abandoned rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = room.players.some(p => p.isBot || p.connId);
    if (!anyoneConnected && now - room.lastActivity > 5 * 60 * 1000) {
      clearPendingTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Kitchen Table Hold'em LIVE server running on port ${PORT}`);
});
