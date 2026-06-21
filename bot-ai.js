const PL = require('./logic.js');
const PE = require('./engine.js');

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function handStrength(game, player) {
  const cards = [...player.holeCards, ...game.communityCards];
  if (cards.length < 5) {
    const [a, b] = player.holeCards;
    const hi = Math.max(a.rank, b.rank), lo = Math.min(a.rank, b.rank);
    let score = (hi - 2) / 12 * 0.45 + (lo - 2) / 12 * 0.25;
    if (a.rank === b.rank) score += 0.32;
    if (a.suit === b.suit) score += 0.07;
    const gap = hi - lo;
    if (gap <= 1) score += 0.07; else if (gap <= 2) score += 0.03;
    return Math.min(1, score);
  }
  const res = PL.evaluateBest(cards);
  let score = res.score[0] / 8;
  score += Math.min(0.08, ((res.score[1] || 0) / 14) * 0.08);
  return Math.min(1, score);
}

function raiseSized(game, va, effective, potTotal) {
  let raiseTo;
  if (effective > 0.92 && Math.random() < 0.3) raiseTo = va.maxRaiseTo;
  else {
    const frac = 0.45 + Math.random() * 0.65;
    raiseTo = game.currentBet + Math.max(va.minRaiseTo - game.currentBet, Math.round(potTotal * frac));
  }
  raiseTo = clamp(raiseTo, va.minRaiseTo, va.maxRaiseTo);
  return { type: game.currentBet > 0 ? 'raise' : 'bet', amount: raiseTo };
}

function botDecide(game) {
  const va = PE.getValidActions(game);
  const player = game.players[va.playerIndex];
  const strength = handStrength(game, player);
  const noise = (Math.random() - 0.5) * 0.16;
  const effective = Math.min(1, Math.max(0, strength + noise));
  const potTotal = game.players.reduce((s, p) => s + p.totalContributionThisHand, 0);
  const toCall = va.callAmount;
  const potOdds = toCall > 0 ? toCall / (potTotal + toCall) : 0;

  if (va.canCheck) {
    if (effective > 0.6 && va.canRaise && Math.random() < 0.5) return raiseSized(game, va, effective, potTotal);
    return { type: 'check' };
  } else {
    const foldThresh = 0.16 + potOdds * 0.45;
    if (effective < foldThresh) return { type: 'fold' };
    if (effective > 0.66 && va.canRaise && Math.random() < 0.42) return raiseSized(game, va, effective, potTotal);
    return { type: 'call' };
  }
}

module.exports = { botDecide };
