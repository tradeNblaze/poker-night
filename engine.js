(function (root) {
  const { makeDeck, shuffle, evaluateBest, compareScores, buildPots, RANK_NAMES } =
    (typeof module !== 'undefined') ? require('./logic.js') : root.PokerLogic;

  function createGame(playerConfigs, smallBlind, bigBlind) {
    return {
      players: playerConfigs.map((p, i) => ({
        id: p.id != null ? p.id : i,
        name: p.name,
        isBot: !!p.isBot,
        chips: p.chips,
        holeCards: [],
        folded: false,
        allIn: false,
        isOut: false,
        contributionThisRound: 0,
        totalContributionThisHand: 0,
        hasActedThisRound: false,
      })),
      communityCards: [],
      deck: [],
      smallBlind,
      bigBlind,
      dealerIndex: -1,
      stage: 'waiting', // waiting | preflop | flop | turn | river | showdown | hand-over
      currentBet: 0,
      minRaiseSize: bigBlind,
      currentPlayerIndex: -1,
      handNumber: 0,
      log: [],
      lastHandResult: null,
      gameOver: false,
    };
  }

  function seatedPlayers(game) {
    return game.players.filter(p => !p.isOut);
  }

  function nextSeatIndex(game, fromIndex, predicate) {
    const n = game.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIndex + step) % n;
      if (predicate(game.players[idx])) return idx;
    }
    return -1;
  }

  function canAct(p) {
    return !p.isOut && !p.folded && !p.allIn && p.chips > 0;
  }
  function inHand(p) {
    return !p.isOut && !p.folded;
  }

  function log(game, msg) {
    game.log.push(msg);
  }

  function postBet(game, player, amount) {
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.contributionThisRound += actual;
    player.totalContributionThisHand += actual;
    if (player.chips === 0) player.allIn = true;
    return actual;
  }

  function startHand(game) {
    const live = seatedPlayers(game);
    if (live.length < 2) { game.gameOver = true; return; }

    game.handNumber += 1;
    game.communityCards = [];
    game.log = [];
    game.lastHandResult = null;
    game.players.forEach(p => {
      p.folded = p.isOut;
      p.allIn = false;
      p.holeCards = [];
      p.contributionThisRound = 0;
      p.totalContributionThisHand = 0;
      p.hasActedThisRound = false;
    });

    if (game.dealerIndex === -1) {
      game.dealerIndex = game.players.indexOf(live[0]); // first hand: first seated player is dealer
    } else {
      const nd = nextSeatIndex(game, game.dealerIndex, p => !p.isOut);
      game.dealerIndex = nd === -1 ? game.players.indexOf(live[0]) : nd;
    }

    game.deck = shuffle(makeDeck());

    const headsUp = live.length === 2;
    const sbIndex = headsUp ? game.dealerIndex : nextSeatIndex(game, game.dealerIndex, p => !p.isOut);
    const bbIndex = nextSeatIndex(game, sbIndex, p => !p.isOut);

    game.players.forEach(p => { if (!p.isOut) p.holeCards = [game.deck.pop(), game.deck.pop()]; });

    const sbPlayer = game.players[sbIndex];
    const bbPlayer = game.players[bbIndex];
    game.sbIndex = sbIndex;
    game.bbIndex = bbIndex;
    const sbPosted = postBet(game, sbPlayer, game.smallBlind);
    const bbPosted = postBet(game, bbPlayer, game.bigBlind);
    log(game, `${sbPlayer.name} posts small blind (${sbPosted})`);
    log(game, `${bbPlayer.name} posts big blind (${bbPosted})`);

    game.stage = 'preflop';
    game.currentBet = Math.max(sbPlayer.contributionThisRound, bbPlayer.contributionThisRound);
    game.minRaiseSize = game.bigBlind;
    game.currentPlayerIndex = nextSeatIndex(game, bbIndex, p => canAct(p));
    if (game.currentPlayerIndex === -1) {
      // everyone else is all-in already (e.g. tiny stacks) - go straight to showdown after dealing out
      resolveAutoRunOut(game);
    }
  }

  function activeActableCount(game) {
    return game.players.filter(canAct).length;
  }

  function isRoundOver(game) {
    const actable = game.players.filter(canAct);
    const inHandPlayers = game.players.filter(inHand);
    if (inHandPlayers.length <= 1) return true;
    if (actable.length === 0) return true;
    if (actable.length === 1) {
      // the lone actable player must still match the current bet to close the round if others called all-in already at lower amounts is handled elsewhere; if everyone else is all-in/folded and this one player has matched currentBet (or there is nothing to call), round is over.
      const p = actable[0];
      return p.hasActedThisRound && p.contributionThisRound === game.currentBet;
    }
    return actable.every(p => p.hasActedThisRound && p.contributionThisRound === game.currentBet);
  }

  function getValidActions(game) {
    const p = game.players[game.currentPlayerIndex];
    if (!p) return null;
    const toCall = game.currentBet - p.contributionThisRound;
    const canCheck = toCall <= 0;
    const canCall = toCall > 0;
    const callAmount = Math.min(toCall, p.chips);
    const minRaiseTo = game.currentBet + game.minRaiseSize;
    const maxRaiseTo = p.contributionThisRound + p.chips; // all-in
    const canRaise = p.chips > toCall; // has chips left over after calling
    return {
      playerIndex: game.currentPlayerIndex,
      canFold: true,
      canCheck,
      canCall,
      callAmount,
      canRaise,
      minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
      maxRaiseTo,
    };
  }

  function applyAction(game, action) {
    const p = game.players[game.currentPlayerIndex];
    if (!p) return;
    const toCall = game.currentBet - p.contributionThisRound;

    if (action.type === 'fold') {
      p.folded = true;
      log(game, `${p.name} folds`);
    } else if (action.type === 'check') {
      p.hasActedThisRound = true;
      log(game, `${p.name} checks`);
    } else if (action.type === 'call') {
      const amt = postBet(game, p, toCall);
      p.hasActedThisRound = true;
      log(game, p.allIn ? `${p.name} calls ${amt} (all-in)` : `${p.name} calls ${amt}`);
    } else if (action.type === 'bet' || action.type === 'raise') {
      const raiseTo = action.amount;
      const needed = raiseTo - p.contributionThisRound;
      const raiseSize = raiseTo - game.currentBet;
      const amt = postBet(game, p, needed);
      const wentAllIn = p.allIn;
      // Reopen action for everyone else still able to act
      game.players.forEach(other => {
        if (other !== p && canAct(other)) other.hasActedThisRound = false;
      });
      p.hasActedThisRound = true;
      game.currentBet = Math.max(game.currentBet, p.contributionThisRound);
      if (raiseSize > 0) game.minRaiseSize = raiseSize;
      log(game, `${p.name} ${action.type}s to ${p.contributionThisRound}${wentAllIn ? ' (all-in)' : ''}`);
    }

    // Check if hand ends because everyone else folded
    const remaining = game.players.filter(inHand);
    if (remaining.length === 1) {
      finishHandByFold(game, remaining[0]);
      return;
    }

    if (isRoundOver(game)) {
      advanceStage(game);
    } else {
      game.currentPlayerIndex = nextSeatIndex(game, game.currentPlayerIndex, p => canAct(p));
    }
  }

  function finishHandByFold(game, winner) {
    const totalWon = game.players.reduce((s, p) => s + p.totalContributionThisHand, 0);
    winner.chips += totalWon;
    log(game, `${winner.name} wins the pot of ${totalWon} (everyone else folded)`);
    game.stage = 'hand-over';
    game.lastHandResult = {
      winners: [{ id: winner.id, name: winner.name, amount: totalWon }],
      showdown: false,
      hands: [],
    };
    checkGameOver(game);
  }

  function advanceStage(game) {
    // reset round contribution tracking
    game.players.forEach(p => { p.contributionThisRound = 0; p.hasActedThisRound = false; });
    game.currentBet = 0;
    game.minRaiseSize = game.bigBlind;

    if (game.stage === 'preflop') { dealCommunity(game, 3); game.stage = 'flop'; log(game, 'Flop: ' + cardStr(game.communityCards)); }
    else if (game.stage === 'flop') { dealCommunity(game, 1); game.stage = 'turn'; log(game, 'Turn: ' + cardStr(game.communityCards)); }
    else if (game.stage === 'turn') { dealCommunity(game, 1); game.stage = 'river'; log(game, 'River: ' + cardStr(game.communityCards)); }
    else if (game.stage === 'river') { doShowdown(game); return; }

    const actable = game.players.filter(canAct);
    if (actable.length <= 1) {
      // no more betting possible - auto run out remaining streets
      resolveAutoRunOut(game);
      return;
    }
    game.currentPlayerIndex = nextSeatIndex(game, game.dealerIndex, p => canAct(p));
  }

  function resolveAutoRunOut(game) {
    while (game.stage !== 'river' && game.stage !== 'showdown') {
      if (game.stage === 'preflop') { dealCommunity(game, 3); game.stage = 'flop'; }
      else if (game.stage === 'flop') { dealCommunity(game, 1); game.stage = 'turn'; }
      else if (game.stage === 'turn') { dealCommunity(game, 1); game.stage = 'river'; }
    }
    log(game, 'Board runs out: ' + cardStr(game.communityCards));
    doShowdown(game);
  }

  function dealCommunity(game, n) {
    for (let i = 0; i < n; i++) game.communityCards.push(game.deck.pop());
  }

  function cardStr(cards) {
    return cards.map(c => RANK_NAMES[c.rank] + c.suit).join(' ');
  }

  function doShowdown(game) {
    game.stage = 'showdown';
    const contenders = game.players.filter(inHand);
    const evals = contenders.map(p => ({
      player: p,
      result: evaluateBest([...p.holeCards, ...game.communityCards]),
    }));

    const pots = buildPots(game.players.map(p => ({ id: p.id, folded: p.folded, totalContribution: p.totalContributionThisHand })));
    const winnings = {}; // id -> amount won
    pots.forEach(pot => {
      const eligible = evals.filter(e => pot.eligiblePlayerIds.includes(e.player.id));
      if (eligible.length === 0) return;
      let best = eligible[0].result.score;
      eligible.forEach(e => { if (compareScores(e.result.score, best) > 0) best = e.result.score; });
      const winners = eligible.filter(e => compareScores(e.result.score, best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // order winners by seat position after dealer for odd-chip distribution
      const ordered = winners.slice().sort((a, b) => {
        const ai = (game.players.indexOf(a.player) - game.dealerIndex + game.players.length) % game.players.length;
        const bi = (game.players.indexOf(b.player) - game.dealerIndex + game.players.length) % game.players.length;
        return ai - bi;
      });
      ordered.forEach((w, i) => {
        const amt = share + (i < remainder ? 1 : 0);
        winnings[w.player.id] = (winnings[w.player.id] || 0) + amt;
        w.player.chips += amt;
      });
    });

    const winnerList = Object.entries(winnings).map(([id, amount]) => {
      const player = game.players.find(p => String(p.id) === String(id));
      return { id: player.id, name: player.name, amount };
    });
    winnerList.forEach(w => log(game, `${w.name} wins ${w.amount}`));

    game.stage = 'hand-over';
    game.lastHandResult = {
      winners: winnerList,
      showdown: true,
      hands: evals.map(e => ({ id: e.player.id, name: e.player.name, holeCards: e.player.holeCards, handName: e.result.name, score: e.result.score })),
    };
    checkGameOver(game);
  }

  function checkGameOver(game) {
    game.players.forEach(p => { if (p.chips <= 0) p.isOut = true; });
    const remaining = seatedPlayers(game);
    if (remaining.length <= 1) {
      game.gameOver = true;
    }
  }

  const Engine = { createGame, startHand, applyAction, getValidActions, seatedPlayers, canAct, inHand, cardStr };

  if (typeof module !== 'undefined') module.exports = Engine;
  else root.PokerEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
