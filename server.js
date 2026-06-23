const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWebSocketServer } = require('./ws-server.js');
const PE = require('./engine.js');
const PL = require('./logic.js');
const { botDecide } = require('./bot-ai.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 9;
const MIN_PLAYERS = 2;
const TURN_TIME_MS = Number(process.env.TURN_TIME_MS) || 20000; // every human gets this long to act
const BOT_DELAY_MIN = 600, BOT_DELAY_MAX = 1100;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1

// Last line of defense: log and survive instead of crashing every active game over one bad error.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (server kept running):', err);
});

// ===================== PERSISTENCE (Upstash Redis REST API) =====================
// Optional: if UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN aren't set, the server
// runs exactly as before with no persistence. Set them to survive a server restart.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PERSISTENCE_ENABLED = !!(REDIS_URL && REDIS_TOKEN);
const ROOM_TTL_SECONDS = 24 * 60 * 60; // saved rooms expire after 24h of no updates

async function redisCommand(args) {
  if (!PERSISTENCE_ENABLED) return null;
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data && 'result' in data ? data.result : null;
  } catch (err) {
    console.error('Redis command failed:', args[0], err.message);
    return null;
  }
}

function serializeRoomForPersistence(room) {
  return {
    code: room.code,
    settings: room.settings,
    phase: room.phase,
    game: room.game,
    tournament: room.tournament,
    lastActivity: room.lastActivity,
    players: room.players.map(p => ({
      seatIndex: p.seatIndex, name: p.name, isBot: p.isBot, token: p.token,
      chips: p.chips, removed: p.removed,
      // connId/_gp intentionally omitted - meaningless after a restart, rebuilt on load
    })),
  };
}

function deserializeRoomFromPersistence(saved) {
  const room = {
    code: saved.code,
    settings: saved.settings,
    phase: saved.phase,
    game: saved.game,
    tournament: saved.tournament || null,
    tournamentTimer: null,
    lastActivity: saved.lastActivity || Date.now(),
    pendingTimer: null,
    players: saved.players.map(p => ({ ...p, connId: null, _gp: null })),
  };
  if (room.game) {
    for (const p of room.players) {
      p._gp = room.game.players.find(gp => gp.id === p.seatIndex) || null;
    }
  }
  return room;
}

function persistRoom(room) {
  if (!PERSISTENCE_ENABLED) return;
  const payload = JSON.stringify(serializeRoomForPersistence(room));
  redisCommand(['SET', `room:${room.code}`, payload, 'EX', String(ROOM_TTL_SECONDS)]);
  // fire-and-forget - don't make every player action wait on a network round trip
}

async function loadRoomFromRedis(code) {
  if (!PERSISTENCE_ENABLED) return null;
  const raw = await redisCommand(['GET', `room:${code}`]);
  if (!raw) return null;
  try {
    return deserializeRoomFromPersistence(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to parse persisted room', code, err.message);
    return null;
  }
}

function deleteRoomFromRedis(code) {
  if (!PERSISTENCE_ENABLED) return;
  redisCommand(['DEL', `room:${code}`]);
}

// Looks in memory first; if the server just restarted and this room isn't loaded yet,
// tries to restore it from Redis before giving up.
async function getOrLoadRoom(code) {
  let room = rooms.get(code);
  if (room) return room;
  room = await loadRoomFromRedis(code);
  if (room) {
    rooms.set(code, room);
    if (room.phase === 'playing') scheduleNextActorIfNeeded(room); // re-arm whatever timer was running
    if (room.tournament) armTournamentTimer(room); // resume the blind-level clock from where it left off
  }
  return room;
}

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
    settings: { chips: 1000, sb: 5, bb: 10, mode: 'cash', roundMinutes: 5 },
    phase: 'lobby', // lobby | playing
    game: null,
    tournament: null, // { level, sb, bb, roundMs, levelDeadline } - only set when mode is 'tournament'
    tournamentTimer: null,
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
    tournament: room.tournament ? {
      level: room.tournament.level, sb: room.tournament.sb, bb: room.tournament.bb,
      levelDeadline: room.tournament.levelDeadline, roundMs: room.tournament.roundMs,
    } : null,
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
  base.turnDeadline = (g.stage !== 'hand-over' && g.turnDeadline) ? g.turnDeadline : null;
  base.turnDurationMs = TURN_TIME_MS;
  base.pot = g.players.reduce((s, p) => s + p.totalContributionThisHand, 0);
  base.currentBet = g.currentBet;
  base.bigBlind = g.bigBlind;
  base.communityCards = g.communityCards;
  base.log = g.log;
  base.gameOver = g.gameOver;

  if (g.lastHandResult) {
    const hands = g.lastHandResult.hands.map(h => ({ seat: h.id, name: h.name, holeCards: h.holeCards, handName: h.handName }));
    const alreadyShown = new Set(hands.map(h => h.seat));
    if (room.voluntaryShows) {
      for (const seat of room.voluntaryShows) {
        if (alreadyShown.has(seat)) continue;
        const engineIdx = seatToEngineIndex(room, seat);
        const gp = engineIdx !== -1 ? g.players[engineIdx] : null;
        if (!gp || !gp.holeCards || gp.holeCards.length === 0) continue;
        const totalCards = gp.holeCards.length + g.communityCards.length;
        let handName = null;
        if (totalCards >= 5) {
          try { handName = PL.evaluateBest([...gp.holeCards, ...g.communityCards]).name; } catch (e) { handName = null; }
        }
        hands.push({ seat, name: gp.name, holeCards: gp.holeCards, handName, voluntary: true });
        alreadyShown.add(seat);
      }
    }
    base.lastHandResult = {
      showdown: g.lastHandResult.showdown,
      winners: g.lastHandResult.winners.map(w => ({ seat: w.id, name: w.name, amount: w.amount })),
      hands,
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
  persistRoom(room);
}

// ===================== GAME FLOW =====================
function startGame(room) {
  const seated = room.players.filter(p => !p.removed);
  const configs = seated.map(p => ({ id: p.seatIndex, name: p.name, isBot: p.isBot, chips: room.settings.chips }));
  startTournamentIfNeeded(room);
  const startSb = room.tournament ? room.tournament.sb : room.settings.sb;
  const startBb = room.tournament ? room.tournament.bb : room.settings.bb;
  const game = PE.createGame(configs, startSb, startBb);
  room.game = game;
  room.phase = 'playing';
  room.voluntaryShows = new Set();
  // link engine players back to room players for chip persistence/view
  for (const p of room.players) {
    p._gp = game.players.find(gp => gp.id === p.seatIndex) || null;
  }
  PE.startHand(game);
  syncChipsToRoomPlayers(room);
  scheduleNextActorIfNeeded(room);
  broadcast(room);
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
  if (room.game) room.game.turnDeadline = null;
}

// ===================== TOURNAMENT MODE =====================
function clearTournamentTimer(room) {
  if (room.tournamentTimer) {
    clearTimeout(room.tournamentTimer);
    room.tournamentTimer = null;
  }
}

function blindsForLevel(baseSb, baseBb, level) {
  const mult = Math.pow(2, level - 1); // simple doubling each level - structure can be customized later
  return { sb: baseSb * mult, bb: baseBb * mult };
}

function startTournamentIfNeeded(room) {
  clearTournamentTimer(room);
  if (room.settings.mode !== 'tournament') { room.tournament = null; return; }
  const roundMs = Math.max(1, Number(room.settings.roundMinutes) || 5) * 60 * 1000;
  const { sb, bb } = blindsForLevel(room.settings.sb, room.settings.bb, 1);
  room.tournament = { level: 1, sb, bb, roundMs, levelDeadline: Date.now() + roundMs };
  armTournamentTimer(room);
}

function armTournamentTimer(room) {
  clearTournamentTimer(room);
  if (!room.tournament) return;
  const delay = Math.max(0, room.tournament.levelDeadline - Date.now());
  room.tournamentTimer = setTimeout(() => {
    try { levelUpTournament(room); } catch (err) { console.error('Tournament level-up error in room', room.code, err); }
  }, delay);
}

function levelUpTournament(room) {
  if (!room.tournament) return;
  room.tournament.level += 1;
  const { sb, bb } = blindsForLevel(room.settings.sb, room.settings.bb, room.tournament.level);
  room.tournament.sb = sb;
  room.tournament.bb = bb;
  if (room.game) {
    // Takes effect starting the next hand - a hand already in progress keeps its original blinds.
    room.game.smallBlind = sb;
    room.game.bigBlind = bb;
  }
  room.tournament.levelDeadline = Date.now() + room.tournament.roundMs;
  armTournamentTimer(room);
  broadcast(room);
}

function scheduleNextActorIfNeeded(room) {
  clearPendingTimer(room);
  const g = room.game;
  if (!g || g.stage === 'hand-over') return;
  const gp = g.players[g.currentPlayerIndex];
  if (!gp) return;

  if (gp.isBot) {
    const timer = setTimeout(() => {
      try {
        if (!room.game || room.game.stage === 'hand-over') return;
        const action = botDecide(room.game);
        applyActionAndAdvance(room, action);
      } catch (err) {
        console.error('Bot decision error in room', room.code, err);
        try {
          if (room.game && room.game.stage !== 'hand-over') {
            const va = PE.getValidActions(room.game);
            if (va) applyActionAndAdvance(room, { type: va.canCheck ? 'check' : 'fold' });
          }
        } catch (err2) {
          console.error('Recovery fold also failed in room', room.code, err2);
        }
      }
    }, BOT_DELAY_MIN + Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN));
    room.pendingTimer = { seatIndex: gp.id, timer };
    return;
  }

  // Every human gets a turn clock - whether they're connected and just slow, or disconnected entirely.
  // Either way, the table can't be allowed to wait forever.
  g.turnDeadline = Date.now() + TURN_TIME_MS;
  const timer = setTimeout(() => {
    try {
      if (!room.game || room.game.stage === 'hand-over') return;
      const va = PE.getValidActions(room.game);
      if (!va) return;
      const action = va.canCheck ? { type: 'check' } : { type: 'fold' };
      applyActionAndAdvance(room, action);
    } catch (err) {
      console.error('Turn-timer auto-act error in room', room.code, err);
    }
  }, TURN_TIME_MS);
  room.pendingTimer = { seatIndex: gp.id, timer };
}

function applyActionAndAdvance(room, action) {
  PE.applyAction(room.game, action);
  syncChipsToRoomPlayers(room);
  if (room.game.stage === 'hand-over') {
    clearPendingTimer(room);
  } else {
    scheduleNextActorIfNeeded(room);
  }
  broadcast(room);
}

// ===================== MESSAGE HANDLERS =====================
async function handleMessage(connId, raw) {
  const conn = connections.get(connId);
  if (!conn) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return sendError(conn.ws, 'Bad message'); }
  if (!msg || typeof msg.type !== 'string') return;

  try {
    switch (msg.type) {
      case 'create_room': return onCreateRoom(connId, msg);
      case 'join_room': return await onJoinRoom(connId, msg);
      case 'add_bot': return onAddBot(connId, msg);
      case 'remove_player': return onRemovePlayer(connId, msg);
      case 'update_settings': return onUpdateSettings(connId, msg);
      case 'start_game': return onStartGame(connId, msg);
      case 'action': return onAction(connId, msg);
      case 'next_hand': return onNextHand(connId, msg);
      case 'show_cards': return onShowCards(connId, msg);
      case 'return_to_lobby': return onReturnToLobby(connId, msg);
      case 'leave_room': return onLeaveRoom(connId, msg);
      case 'ping': return; // keepalive no-op
    }
  } catch (err) {
    console.error('Error handling message type', msg.type, err);
    sendError(conn.ws, 'Something went wrong with that action - please try again.');
  }
}

function onReturnToLobby(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'playing' || !room.game || !room.game.gameOver) return;
  clearPendingTimer(room);
  clearTournamentTimer(room);
  room.tournament = null;
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

async function onJoinRoom(connId, msg) {
  const conn = connections.get(connId);
  const code = String(msg.roomCode || '').trim().toUpperCase();
  const room = await getOrLoadRoom(code);
  if (!room) return sendError(conn.ws, 'Room not found. Check the code and try again.');

  // reconnect path (same device/browser still has the token)
  if (msg.token) {
    const existing = room.players.find(p => p.token === msg.token);
    if (existing) {
      existing.connId = connId;
      conn.roomCode = room.code;
      conn.seatIndex = existing.seatIndex;
      send(conn.ws, { type: 'joined', roomCode: room.code, token: existing.token, seatIndex: existing.seatIndex });
      clearPendingTimerIfMatches(room, existing.seatIndex); // they're back, cancel auto-act timer for them specifically
      scheduleNextActorIfNeeded(room); // re-evaluate (might still be their turn, now connected -> restart their own clock)
      broadcast(room);
      return;
    }
  }

  // mid-game rejoin-by-name path (lost the token - cleared browser data, new device, etc.)
  // If the room code + the same name matches a seat that's currently disconnected, let them back into THAT seat
  // rather than locking them out for the rest of the game.
  if (room.phase === 'playing') {
    const typedName = String(msg.name || '').trim().toLowerCase();
    if (typedName) {
      const reclaimable = room.players.find(p => !p.isBot && !p.connId && p.name.trim().toLowerCase() === typedName);
      if (reclaimable) {
        reclaimable.token = genToken(); // issue a fresh token for this new session
        reclaimable.connId = connId;
        conn.roomCode = room.code;
        conn.seatIndex = reclaimable.seatIndex;
        send(conn.ws, { type: 'joined', roomCode: room.code, token: reclaimable.token, seatIndex: reclaimable.seatIndex });
        clearPendingTimerIfMatches(room, reclaimable.seatIndex);
        scheduleNextActorIfNeeded(room);
        broadcast(room);
        return;
      }
    }
    return sendError(conn.ws, "This game already started. If you're rejoining, make sure you type the exact same name you used before.");
  }

  const activeCount = room.players.filter(p => !p.removed).length;
  if (activeCount >= MAX_PLAYERS) return sendError(conn.ws, 'This table is full.');

  const name = String(msg.name || '').trim().slice(0, 18) || ('Player ' + (activeCount + 1));
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
  if (s.mode === 'cash' || s.mode === 'tournament') room.settings.mode = s.mode;
  if (Number.isFinite(s.roundMinutes) && s.roundMinutes >= 1 && s.roundMinutes <= 60) room.settings.roundMinutes = Math.floor(s.roundMinutes);
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
  room.voluntaryShows = new Set();
  PE.startHand(room.game);
  syncChipsToRoomPlayers(room);
  scheduleNextActorIfNeeded(room);
  broadcast(room);
}

function onShowCards(connId, msg) {
  const conn = connections.get(connId);
  const room = rooms.get(conn.roomCode);
  if (!room || room.phase !== 'playing' || !room.game) return;
  if (room.game.stage !== 'hand-over') return;
  const engineIdx = seatToEngineIndex(room, conn.seatIndex);
  if (engineIdx === -1) return; // wasn't dealt into this hand
  if (!room.voluntaryShows) room.voluntaryShows = new Set();
  room.voluntaryShows.add(conn.seatIndex);
  broadcast(room);
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
    clearTournamentTimer(room);
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

  ws.on('message', (raw) => { handleMessage(connId, raw).catch(err => console.error('Unhandled error in handleMessage:', err)); });
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
      clearTournamentTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Kitchen Table Hold'em LIVE server running on port ${PORT}`);
});
