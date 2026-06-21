// ===== Card / Deck =====
const SUITS = ['S', 'H', 'D', 'C'];
const RANK_NAMES = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ rank: r, suit: s });
    }
  }
  return deck;
}

function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ===== Combinations =====
function combinations(arr, k) {
  const results = [];
  const combo = [];
  function go(start) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      go(i + 1);
      combo.pop();
    }
  }
  go(0);
  return results;
}

// ===== 5 card hand evaluation =====
// Returns { score: [category, tiebreak...], name: string }
const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'
];

function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const countEntries = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => (b.count - a.count) || (b.rank - a.rank));

  const uniqueDesc = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false, straightHigh = 0;
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) {
      isStraight = true; straightHigh = uniqueDesc[0];
    } else if (uniqueDesc[0] === 14 && uniqueDesc[1] === 5 && uniqueDesc[2] === 4 && uniqueDesc[3] === 3 && uniqueDesc[4] === 2) {
      isStraight = true; straightHigh = 5; // wheel
    }
  }

  let category, tiebreak, name;

  if (isStraight && isFlush) {
    category = 8; tiebreak = [straightHigh];
    name = `Straight Flush, ${RANK_NAMES[straightHigh]} high`;
  } else if (countEntries[0].count === 4) {
    const quad = countEntries[0].rank;
    const kicker = countEntries.find(e => e.count !== 4).rank;
    category = 7; tiebreak = [quad, kicker];
    name = `Four of a Kind, ${RANK_NAMES[quad]}s`;
  } else if (countEntries[0].count === 3 && countEntries[1] && countEntries[1].count >= 2) {
    const trip = countEntries[0].rank;
    const pair = countEntries[1].rank;
    category = 6; tiebreak = [trip, pair];
    name = `Full House, ${RANK_NAMES[trip]}s over ${RANK_NAMES[pair]}s`;
  } else if (isFlush) {
    category = 5; tiebreak = ranks.slice();
    name = `Flush, ${RANK_NAMES[ranks[0]]} high`;
  } else if (isStraight) {
    category = 4; tiebreak = [straightHigh];
    name = `Straight, ${RANK_NAMES[straightHigh]} high`;
  } else if (countEntries[0].count === 3) {
    const trip = countEntries[0].rank;
    const kickers = countEntries.filter(e => e.count === 1).map(e => e.rank).sort((a, b) => b - a);
    category = 3; tiebreak = [trip, ...kickers];
    name = `Three of a Kind, ${RANK_NAMES[trip]}s`;
  } else if (countEntries[0].count === 2 && countEntries[1] && countEntries[1].count === 2) {
    const pairs = countEntries.filter(e => e.count === 2).map(e => e.rank).sort((a, b) => b - a);
    const kicker = countEntries.find(e => e.count === 1).rank;
    category = 2; tiebreak = [pairs[0], pairs[1], kicker];
    name = `Two Pair, ${RANK_NAMES[pairs[0]]}s and ${RANK_NAMES[pairs[1]]}s`;
  } else if (countEntries[0].count === 2) {
    const pair = countEntries[0].rank;
    const kickers = countEntries.filter(e => e.count === 1).map(e => e.rank).sort((a, b) => b - a);
    category = 1; tiebreak = [pair, ...kickers];
    name = `Pair of ${RANK_NAMES[pair]}s`;
  } else {
    category = 0; tiebreak = ranks.slice();
    name = `High Card, ${RANK_NAMES[ranks[0]]}`;
  }

  return { score: [category, ...tiebreak], name };
}

function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Evaluate best hand from 5,6, or 7 cards
function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const res = evaluate5(combo);
    if (!best || compareScores(res.score, best.score) > 0) best = res;
  }
  return best;
}

// ===== Side pots =====
// players: [{ id, folded, totalContribution }]
function buildPots(players) {
  const contributors = players.filter(p => p.totalContribution > 0);
  const levelsSet = new Set(
    players.filter(p => !p.folded && p.totalContribution > 0).map(p => p.totalContribution)
  );
  const levels = [...levelsSet].sort((a, b) => a - b);
  const pots = [];
  let prevLevel = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of contributors) {
      amount += Math.min(p.totalContribution, level) - Math.min(p.totalContribution, prevLevel);
    }
    if (amount > 0) {
      const eligible = players.filter(p => !p.folded && p.totalContribution >= level).map(p => p.id);
      pots.push({ amount, eligiblePlayerIds: eligible });
    }
    prevLevel = level;
  }
  return pots;
}

const PokerLogic = { makeDeck, shuffle, combinations, evaluate5, evaluateBest, compareScores, buildPots, CATEGORY_NAMES, RANK_NAMES };

if (typeof module !== 'undefined') module.exports = PokerLogic;
else (typeof window !== 'undefined' ? window : globalThis).PokerLogic = PokerLogic;
