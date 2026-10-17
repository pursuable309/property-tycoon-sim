/**
 * AI: Tuning
 *
 * Runtime overrides for a curated set of AI constants. Defaults live in
 * their home tables (CPUPlayer.DIFFICULTY, Personalities.ARCHETYPES,
 * Evaluator literals); this module stores only the sparse set of values
 * the user changed, persisted to localStorage. The History tab's review
 * recommendations point at these knob paths.
 *
 * Registry paths:
 *   difficulty.{1..5}.{noise|blunder|tradeMargin|lookahead} + difficulty.4.auctionSmarts
 *   archetype.{name}.{buyBias|bidBias|cashFloorMul|buildBias|tradeFrequency}
 *   evaluator.{setCompletionMul|jailCardValue|cashFloorScale|lookahead*|...}
 *
 * Dependencies: constants, storage (cpu-player/personalities for defaults,
 *               resolved lazily so load order before them is fine)
 * Exports: window.AITuning
 */

const AITuning = {

    _registry: null,      // path -> { def, min, max, step, label, group }
    _overrides: null,     // sparse path -> value
    _merged: {},          // memo for merged(prefix) objects

    /** Registry is built lazily so the defaults can be read from the live
     *  CPUPlayer / Personalities tables regardless of script order. */
    _ensure() {
        if (this._registry) return;
        const reg = {};
        const diff = (window.CPUPlayer && CPUPlayer.DIFFICULTY) || {};
        Object.keys(diff).forEach(d => {
            reg[`difficulty.${d}.noise`] = { def: diff[d].noise, min: 0, max: 0.8, step: 0.01, label: `d${d} noise`, group: 'Difficulty',
                desc: `Random error on every value judgment a difficulty-${d} CPU makes (buy, bid, trade, build). 0 = judges true value perfectly; higher = more erratic pricing.` };
            reg[`difficulty.${d}.blunder`] = { def: diff[d].blunder, min: 0, max: 0.5, step: 0.01, label: `d${d} blunder rate`, group: 'Difficulty',
                desc: `Chance per decision that a difficulty-${d} CPU makes an outright mistake on purpose (skips a good buy, accepts a bad deal). Makes low difficulties beatable.` };
            reg[`difficulty.${d}.tradeMargin`] = { def: diff[d].tradeMargin, min: -0.3, max: 0.3, step: 0.01, label: `d${d} trade margin`, group: 'Difficulty',
                desc: `Extra profit a difficulty-${d} CPU demands before accepting a trade (0.1 = wants 10% in its favor). Negative = will accept mildly losing deals.` };
            reg[`difficulty.${d}.lookahead`] = { def: diff[d].lookahead || 0, min: 0, max: 1, step: 1, label: `d${d} lookahead`, group: 'Difficulty',
                desc: `1 = difficulty-${d} CPUs simulate big decisions (buy/decline, trade responses) several turns ahead before committing, overriding their gut call when the simulation is decisive. Costs a moment of thinking time per decision.` };
        });
        const arch = (window.Personalities && Personalities.ARCHETYPES) || {};
        Object.keys(arch).forEach(name => {
            reg[`archetype.${name}.buyBias`] = { def: arch[name].buyBias, min: 0.5, max: 2, step: 0.05, label: `${name} buy bias`, group: 'Personalities',
                desc: `How much ${name} CPUs inflate a property's value when deciding to buy the tile they landed on. >1 buys eagerly, <1 passes more (sending it to auction).` };
            reg[`archetype.${name}.bidBias`] = { def: arch[name].bidBias, min: 0.5, max: 2, step: 0.05, label: `${name} bid bias`, group: 'Personalities',
                desc: `Same multiplier but for auction bidding: the ceiling ${name} CPUs will bid up to, relative to their true valuation of the tile.` };
            reg[`archetype.${name}.cashFloorMul`] = { def: arch[name].cashFloorMul, min: 0.3, max: 2.5, step: 0.05, label: `${name} cash floor`, group: 'Personalities',
                desc: `Multiplier on the cash reserve ${name} CPUs try to keep for incoming rent. <1 spends close to broke; >1 hoards cash instead of investing.` };
            reg[`archetype.${name}.buildBias`] = { def: arch[name].buildBias, min: 0.5, max: 2, step: 0.05, label: `${name} build bias`, group: 'Personalities',
                desc: `Eagerness of ${name} CPUs to spend cash on houses/hotels once they own a monopoly. Higher = builds sooner and deeper into their reserve.` };
            reg[`archetype.${name}.tradeFrequency`] = { def: arch[name].tradeFrequency, min: 0, max: 1, step: 0.02, label: `${name} trade frequency`, group: 'Personalities',
                desc: `How often ${name} CPUs go looking for a trade to propose on their turn (0 = never, 1 = every chance they get).` };
        });
        reg['evaluator.setCompletionMul'] = { def: 2.6, min: 1, max: 5, step: 0.1, label: 'Set-completion multiplier', group: 'Evaluator',
            desc: 'All CPUs: value multiplier for a tile that completes one of their color groups. Higher = fight harder (buy/bid/trade) for the last tile of a monopoly.' };
        reg['evaluator.jailCardValue'] = { def: 40, min: 0, max: 150, step: 5, label: 'Jail card value ($)', group: 'Evaluator',
            desc: 'All CPUs: dollar value assigned to a Get Out of Jail Free card when weighing trades.' };
        reg['evaluator.cashFloorScale'] = { def: 1.0, min: 0.5, max: 2, step: 0.05, label: 'Cash reserve scale', group: 'Evaluator',
            desc: 'All CPUs: global scale on the cash reserve they keep against upcoming rent threats (personality cash floor multiplies on top). Lower = bolder spending everywhere.' };
        reg['evaluator.mutualAdvanceDamp'] = { def: 0.25, min: 0.05, max: 1, step: 0.05, label: 'Mutual-advance damping', group: 'Evaluator',
            desc: 'Skilled CPUs: how much the "I helped my opponent toward a set" penalty is softened when the SAME swap also carries me toward a monopoly. Lower = more willing to swap into 3-way splits so everyone completes a set (the human-style untangle); 1 = off.' };
        reg['evaluator.setMoveNudge'] = { def: 0.85, min: 0, max: 0.9, step: 0.05, label: 'Set-move trade nudge', group: 'Evaluator',
            desc: 'Skilled CPUs (d3+): trade frequency to use on a turn when an obvious monopoly move is available (one tile from a set, or holding fodder for a colour it collects), overriding a reluctant archetype\'s low base rate. 0 = off (cautious/hoarder CPUs stay slow to pursue completions).' };
        reg['evaluator.lookaheadRollouts'] = { def: 8, min: 0, max: 24, step: 1, label: 'Lookahead rollouts', group: 'Evaluator',
            desc: 'Lookahead CPUs (d5): simulated games played per candidate action at a gated decision. More = steadier judgment but longer thinking time. 0 = lookahead off everywhere.' };
        reg['evaluator.lookaheadHorizon'] = { def: 20, min: 5, max: 40, step: 5, label: 'Lookahead horizon (steps/player)', group: 'Evaluator',
            desc: 'Lookahead CPUs (d5): engine steps each simulated game plays forward PER ACTIVE PLAYER before scoring (20 = ~4 of my turns ahead at any table size). Scaling with the field matters: a flat budget sees rounds ahead in a 2-player game but barely one in a 5-player game.' };
        reg['evaluator.lookaheadMargin'] = { def: 0.012, min: 0, max: 0.05, step: 0.002, label: 'Lookahead override margin', group: 'Evaluator',
            desc: 'Lookahead CPUs (d5): how decisively a simulated candidate must beat the alternative (as a share of table wealth) before it overrides the ordinary heuristic choice. Higher = rarer, higher-confidence overrides.' };
        reg['evaluator.lookaheadBuyVetoMaxPlayers'] = { def: 2, min: 0, max: 8, step: 1, label: 'Buy-veto max players (lookahead)', group: 'Evaluator',
            desc: 'Player-count gate on the lookahead\'s BUY VETO (d5 only). The rollout looks ~4 of the CPU\'s own turns ahead head-to-head but only ~1 turn ahead in a five-player field, so past this many active players its veto on a wanted, reserve-clearing purchase is mostly noise — and passing on +EV property is expensive. Above the threshold the CPU simply takes such buys; at or below it the rollout is consulted exactly as before. Measured 2026-07-30 (9 cells x 2 shapes): removing the veto raised the 5p d5-d4 gap +4.4 to +5.2 (6/9 cells) with dev% +0.9, but cost -0.6 win / -0.6 capWin head-to-head, hence the gate rather than removal. The rollout is still consulted whenever the heuristic wants to PASS, at every player count, so it can still turn a bad decline into a buy. Set to 8 to restore the old always-veto behavior; 0 disables the buy veto entirely. Turning the whole rollout off (Lookahead rollouts = 0) is NOT the same thing and is catastrophic for d5: head-to-head win -16pp, the d5-d4 gap collapses from +31.7 to -0.4.' };
        reg['evaluator.lookaheadBuyClearRatio'] ={ def: 1.15, min: 0, max: 3, step: 0.05, label: 'Lookahead buy-skip ratio', group: 'Evaluator',
            desc: 'Lookahead CPUs (d5): skip the rollout and just buy when the tile is valued at least this ratio over its price AND the reserve still clears after paying — a comfortably-profitable, affordable buy is not a close call. The short-horizon rollout only credits COMPLETED sets, so it otherwise vetoes clear single-tile acquisitions the CPU never invests out of. 0 = off (rollout gates every affordable buy, the old behavior); 1.15 = buy outright at a 15% edge.' };
        reg['evaluator.lookaheadProposalGate'] = { def: 1, min: 0, max: 1, step: 1, label: 'Lookahead proposal gate (heads-up)', group: 'Evaluator',
            desc: 'Lookahead CPUs (d5), HEADS-UP only (≤2 active players): before actually making a trade offer their heuristic chose, simulate proposing-it vs just-rolling forward and hold the offer back when rolling on scores decisively better (e.g. the deal completes a rival\'s set faster than mine). Sim A/B: a clean d5 win at 2 players, but no gain past 3+ (the rollout\'s influence dilutes with player count), so it only acts heads-up. 1 = on; 0 = off (heuristic proposals go straight out, the old behavior).' };
        reg['evaluator.d5FocusBias'] = { def: 0.30, min: 0, max: 1, step: 0.05, label: 'd5 focus-plan bias (heads-up)', group: 'Evaluator',
            desc: 'Top-difficulty (d5) only, HEADS-UP only (<=2 active players): once the CPU has a color foothold, name its 1-2 best developable groups and reweight buy/auction pricing toward them — boost focus-group tiles by this fraction and mildly de-prioritize (0.6x of it) tiles in a color group it owns none of, so it finishes the sets it started instead of scattering cash and arriving at its own key auction broke. Rails/utilities untouched. Sim A/B: a clean +5.7pp d5 win at 2 players (development held, stacks on the P2 proposal gate), but a quality FAILURE at 5p (win flat/negative AND monopolies-per-survivor down) — concentration is a low-opponent strategy that suppresses development in a fragmented field, so it only acts heads-up. 0 = off.' };
        reg['evaluator.d5FocusMaxPlayers'] = { def: 2, min: 2, max: 8, step: 1, label: 'd5 focus-plan: max active players', group: 'Evaluator',
            desc: 'Widest table (active players) at which the d5 focus plan (evaluator.d5FocusBias) acts. Default 2 = heads-up only, the shipped E24 gate: its 5p A/B (6 cells, before the E38 buy-lift) failed the quality gate. Raised only to re-test concentration at bigger tables; 8 = always on.' };
        reg['evaluator.tradeCompletionReserve'] = { def: 0, min: 0, max: 1.5, step: 0.25, label: 'Trade-completion funding reserve', group: 'Evaluator',
            desc: 'Liquidity discipline on trade-driven set completion. A trade that COMPLETES one of my colour sets but leaves me too cash-poor to put a first house on it just buys an undevelopable monopoly that strip-mortgages and dies — the source of the top tier\'s distress fire-sales (~2.5x d4\'s at 5 players). When >0, any set-completing offer (SetSwap/CashForSet/BuyPair/Package/win-win ConsolidationSwap) is skipped unless the CPU keeps enough cash afterward to fund a first build round; the required reserve is this value x skill x first-round cost (so sharper CPUs, which over-commit more, keep the tighter discipline). Deed-funded completions that preserve cash, and plain advances, are unaffected. This is the trade-path twin of the existing buy-path funding gate. 0 = off (the old behavior; completions go through on the soft valuation discount alone).' };
        reg['evaluator.auctionBlockValue'] = { def: 0, min: 0, max: 1.5, step: 0.25, label: 'Auction leader-denial block value', group: 'Evaluator',
            desc: 'Skill-scaled, leader-weighted block-bidding in auctions (≥3 players). Blocking value is already priced into buy/auction valuation, but flat — the same for every difficulty and it does not grow with the field. When >0, a sharp CPU ESCALATES its auction ceiling to deny the tile that would COMPLETE a leading opponent\'s colour set, up to this value × how developable the set is × how far ahead that opponent is × the CPU\'s skill — bounded to 70% of cash. It only fires with 3+ players (at 2 players your sole opponent is already the leader, and the flat block price handles it), so it adds a multiplayer strategic tier without touching heads-up play. Distinct from bidding to win a tile for yourself: this is a bounded premium to keep a runaway leader from completing a monopoly cheaply at auction. 0 = off.' };
        reg['evaluator.unfreezeSetPriority'] = { def: 1, min: 0, max: 1.5, step: 0.25, label: 'Unfreeze own frozen set first', group: 'Evaluator',
            desc: 'Skill-scaled (d3+) balance-sheet repair. Official rules forbid building on a colour group with ANY mortgaged member, so one mortgaged deed idles a whole monopoly — it earns no rent and none of its partners can take a house. The CPU management order used to rank every legal build above every mortgage lift, so the freeze never healed: cash trickled into whatever cheap group was buildable while a premium set sat dead. Measured at 5 players, this self-inflicted freeze is the LARGEST single reason a d5 monopoly stays under-built (43.6% of its under-built sets, vs 30.7% its own cash reserve and 18.6% real poverty — bank house stock is never the constraint). When >0, lifting the mortgage is priced in the same rent-per-dollar units as buying a house (restored doubled rent + this value x skill x the build ROI it unlocks) and wins when it scores higher; the CPU only starts an unlock it can finish and still build on. Default 1: a play-realism choice (game msmea97e Bailey completed green then left it frozen ~106 turns) — it repairs the single most visible piece of apparent AI stupidity at no measured win-rate cost and only a slight thinning of the d4-d3 rung (analysis 2026-07-28 §7a). 0 = off (always build first).' };
        reg['evaluator.bankScarcityAware'] ={ def: 1, min: 0, max: 1, step: 1, label: 'Bank house-scarcity aware', group: 'Evaluator',
            desc: 'All CPUs: price the 32-house / 12-hotel bank limit into valuation. The rules engine enforces the limit but every CPU valuation used to ignore it — a completed colour set was priced on its full 3-house build-out prospect even with an empty bank, an opponent one tile from a set was feared just as much when they could not buy a house either, and cash handed to a "buildable" rival counted as house money with no houses left to buy. When 1, the development premium in set-completion pricing, blocker/exploitability pricing and the trade enemy-fuel penalty scale by the houses the bank can actually supply; value never falls below the completion baseline (an undeveloped monopoly still earns doubled rent). 0 = the old bank-blind behavior. This is a correctness fix, not a difficulty lever — it applies to every difficulty.' };
        reg['evaluator.railOpportunityMul'] ={ def: 0.55, min: 0.3, max: 1, step: 0.05, label: 'Railroad opportunity discount', group: 'Evaluator',
            desc: 'All CPUs: discount on the railroad SET premium (per-tile value + trade completion reward) when the CPU already has a developable colour position — an owned monopoly short of hotels, or a colour one tile from completion. Railroads cap at $200 and can\'t be built on, so a colour-committed CPU should not pour cash into the 3rd/4th rail. Lower = discount harder; 1 = off (rails valued the same whether or not a colour set is in reach). A pure-rail line with no colour set is never discounted.' };
        reg['evaluator.tradeRefusalCap'] = { def: 3, min: 0, max: 6, step: 1, label: 'Trade refusal cap (stop re-asking)', group: 'Evaluator',
            desc: 'All trading CPUs: after an owner refuses to sell a given tile this many times, stop re-proposing for that (owner, tile) — freeing the one-proposal-per-turn budget for an achievable line. The existing _snubbed cooldown is keyed per OFFER SHAPE (buy:/pkg:/toward:/swap:), so a CPU one tile from a set can nag the same holder indefinitely by rotating cash/package/swap variants (review msnz34g2: Frankie made ~13 offers for Oriental over 80 turns; mso4wx3y: Alex sat on ~$1,800 re-offering for Pennsylvania Ave until bankruptcy). This ledger is shape-independent (keyed owner:tile), fed by TurnEngine on REJECT_TRADE, with escalating backoff (see tradeRefusalBackoff) then a hard stop at this cap; it re-opens if the owner falls into distress (cash < $75 or in debt settlement) since they may finally have to sell. Because a gated generator returns null, the proposal chain then falls through to the consolidation / two-away generators it used to starve. Default 3 (A/B-validated 2026-08-12: win-neutral whole ladder, 0 viol, the visible nag pathology fixed). 0 = off (the old shape-only cooldown).' };
        reg['evaluator.tradeRefusalBackoff'] = { def: 6, min: 4, max: 40, step: 2, label: 'Trade refusal backoff (turns)', group: 'Evaluator',
            desc: 'Companion to evaluator.tradeRefusalCap (no effect when that is 0). After an owner refuses a given tile, wait this many turns before re-proposing for it (2nd+ refusal waits 2.5× as long), until the cap hard-stops re-asks entirely. Lower = re-asks resume sooner (gentler, closer to the old cadence, preserves a persistent CPU\'s edge but de-nags less); higher = longer silence between asks (suppresses more). Default 6 (A/B-validated 2026-08-12: a backoff sweep showed backoff 12 nicked d5\'s capWin ~1.4pp while 6 erased it — d5 Δ −0.1/−0.4 — keeping the cap-3 pathology fix and ~30% fewer doomed re-asks). Backoff 12 reproduces the original hardcoded 12/30-turn cadence.' };
        reg['evaluator.tradeRefusalExp'] = { def: 1, min: 0, max: 1, step: 1, label: 'Exponential refusal backoff (no hard stop)', group: 'Evaluator',
            desc: 'E50. How the refusal ledger (tradeRefusalCap must be >0 to enable it) spaces re-asks. 1 = exponential: wait tradeRefusalBackoff x 2^(n-1) turns after the n-th refusal, capped at 8x, and never stop for good, since a holder\'s position changes and a deedless CPU may have no other line back in (game mv2jir3q: Lane). 0 = the E31 schedule: backoff, then 2.5x, then a hard stop at the cap.' };
        reg['evaluator.brokerMinDifficulty'] = { def: 4, min: 0, max: 5, step: 1, label: 'Broker acquisition min difficulty', group: 'Evaluator',
            desc: 'Enables the 3-way BROKER acquisition line for CPUs at or above this difficulty (0 = off). On maximally-blocked boards the direct route deadlocks: I am one-away on a set but holder B will not sell me the missing tile M (no zone — B blocks the leader), yet B is ITSELF one-away on a different set needing tile P from a third owner C. Buying P from C converts the deadlock into a mutual set-completion swap — next turn _proposeSetSwap offers B "P (completes your set) for M (completes mine)". This generator fires only leg 1 (buy P), and only when that downstream swap is PRE-VERIFIED to clear (_zopaCash on the hypothetical P-for-M swap is non-null), so P is never bought speculatively; leg 1 is also reserve- and fundability-gated over the whole broker cost so it cannot complete into an undevelopable monopoly. The line was seen unbuilt across many reviews (mst4jmfb: a 185-turn Alex/Uma/Quinn stalemate no direct generator could break; also mrtiy89r, mru2fhg3). Default 4 (d4+, A/B-validated 2026-08-14): the motivating game mst4jmfb is a d4 stalemate — its cash-rich stuck LEADER Alex is d4, and the ONLY broker-solvable chain on that board has a d4 buyer (Uma\'s green is correctly UNbrokerable — leg-2 never clears because no one will hand the d5 a premium monopoly), so a d5-exclusive gate leaves the exact grind that motivated the feature unsolved. Win-neutral on the full 3×3 grid (27 cells, ~5400 games): pooled d5 Δ −0.6, gap54 Δ −1.7 with the compression concentrated entirely in the seed-fragile bd ruleset (clean in standard +2.0 / delayed +0.8), 85–88% broker→set conversion, 0 invariant violations. Set to 5 for the d5-EXCLUSIVE gate (marginally cleaner ladder but leaves d4 stalemates like mst4jmfb unsolved); d3+ (3) adds nothing measured — d3 never appears as the broker actor. 0 = off.' };
        reg['evaluator.cpuMaxProposalsPerTurn'] = { def: 2, min: 1, max: 5, step: 1, label: 'CPU proposals per turn', group: 'Evaluator',
            desc: 'All trading CPUs: how many DISTINCT trade offers a CPU may propose in one of its turns, capped by the game\'s own per-turn trade limit (Settings → Trades per turn) — the effective budget is min(this, that setting). A CPU used to self-limit to a single proposal even when the game allowed 2-3, so the deep generators (broker/package/distress-sale) that only fire once the swap/cash-for-set chain comes up empty almost never ran. Raising this lets a CPU make its 2nd+ offer on a busy turn; the generators\' per-turn _snubbed side-effect keeps each offer distinct (an already-tried shape is skipped, so attempt #2 falls deeper into the chain — reaching the broker — rather than re-offering the same deal), and extra proposals fire on decaying odds (evaluator.extraProposalOdds) so a turn reads as busier, not a modal firehose. Default 2. 1 = the old one-proposal-per-turn behavior.' };
        reg['evaluator.extraProposalOdds'] = { def: 0.5, min: 0.1, max: 1, step: 0.05, label: 'Extra-proposal odds decay', group: 'Evaluator',
            desc: 'Companion to evaluator.cpuMaxProposalsPerTurn (no effect when that is 1). The first trade proposal on a turn uses the CPU\'s normal trade frequency; each proposal BEYOND the first has its odds multiplied by this factor (compounding: 2nd attempt x this, 3rd x this², …). Lower = extra proposals are rarer (the budget is a ceiling reached only occasionally); 1 = each allowed proposal is as likely as the first (maxes the budget most turns). Default 0.5.' };
        reg['evaluator.multiplayerBuyLift'] = { def: 0.15, min: 0, max: 0.4, step: 0.05, label: 'Multiplayer buy-bias lift (under-buyers, ≥3p)', group: 'Evaluator',
            desc: 'Additive lift on the BUY/auction valuation multiplier for the UNDER-BUYING archetypes (those whose base buyBias is below 1.0 — cautious 0.85 and builder 0.95), applied ONLY in a 3+ active-player field. Measured problem: after the 2026-07 campaign closed the buy-LESS pole, the CPUs drifted to under-acquisition, and the two newest HEAD games lost with cash in hand (mu6c4jg6 d5 won 2 of 52 auctions; mu4t9i9k d4 won 0 of 24). A/B bt56zo1rr (2026-09-18, 108 cells): an UNGATED buy-bias raise (cautious→1.0, builder→1.1) scored a clean d5 win +3.4 at 5 players (dev% +2.2, games shorter, gap +3.6→+8.4 — not attrition) and +0.3 at 4p, but −1.9 HEADS-UP where the validated ≤2p lookahead already optimizes acquisition. So this lift is player-count-gated to ≥3 players — the mirror of the buy-veto / proposal-gate / focus-bias ≤2p scoping. Additive so a single dose reproduces the reviewed raise exactly (0.85+0.15=1.0, 0.95+0.15=1.1). Bids are untouched (the bidBias raise was measured inert). SHIPPED default 0.15 (2026-09-19, on the bt56zo1rr evidence — the ungated raise reproduces at power, the ≥3p gate zeroes the −1.9 heads-up cost by construction). 0 = off.' };
        reg['evaluator.mutualDampMinTiles'] = { def: 2, min: 1, max: 2, step: 1, label: 'Mutual-damp min tiles held', group: 'Evaluator',
            desc: 'Correctness fix for the mutual-advance damping (evaluator.mutualAdvanceDamp). A swap only counts as carrying ME toward a colour set when I end up holding at least this many tiles of that group AND am one away. At 1 (the old rule) taking ONE of the two brown/dark-blue tiles counted as an advance, so a single Boardwalk forgave 75% of the penalty for handing the human a monopoly (game mud9g25d t193: d5 Ira gave T red for North Carolina + Boardwalk + B&O; the same deal without Boardwalk scored -735). Three-tile groups are unaffected (one-away already means 2 tiles). Default 2; 1 = the old behavior. A/B 2026-09-30 (E42): win-neutral in CPU-only play (reverting it: d5 +0.7 ±2.4 at 5p, +0.4 ±0.7 at 8p) — its value is against human proposers probing for the discount, which sims cannot measure.' };
        reg['evaluator.zopaResponderSkill'] = { def: 1, min: 0, max: 2, step: 1, label: 'Price CPU responders at their own skill', group: 'Evaluator',
            desc: 'Correctness fix in trade pricing. When a CPU prices an offer to another CPU, it predicts the responder\'s valuation. It used to read every responder at a flat skill of 0.75, but a CPU answers at its OWN skill, and the leader-aware handover penalty and mutual damping scale with that. So a sharp CPU over-paid weak CPUs (game mungupgq t64: d5 Zane paid $490 for a swap d2 Frankie valued at about +$36 with no cash) and under-priced d5 responders, making offers they then rejected. 1 = model CPU responders at their own skill (humans stay at 0.75); 2 = also add their set-prospect bonus and archetype temperament (the rest of what they weigh when answering; their private colour bias stays hidden); 0 = the old flat read. The margin half (_respondMargin) was already per-responder. A/B 2026-09-30 (E42, 216 cells): win-NEUTRAL — reverting it cost d5 −2.9 at 5p on the first seed set, but that did not replicate on fresh seeds (+0.3 ±2.2 at 5p, −0.9 ±3.4 at 4p); it ships as a correctness fix (cash per trade −$17–19, no more $490-style overpays to weak CPUs, d5 responders accept more). Watch: ping-pong games at 5p 1.1% → 2.4%. Level 2 restored the accept rate on offers to d1-d3 but cost d5 −1.3/−0.8 and made 5p games 19% longer: cheap offers that sometimes get refused beat paying more, so it stays at 1.' };
        reg['evaluator.zopaExactCash'] = { def: 2, min: 0, max: 3, step: 1, label: 'Exact-cash trade pricing', group: 'Evaluator',
            desc: 'Correctness fix in trade pricing (E46). A CPU picking how much cash to put in an offer used to take both sides\' trade utility at $0 and assume each dollar moved it by one dollar. Real trade utility is steeper: paying below my cash floor costs 1.2x, cash handed to a player with a buildable set costs another 0.5x (enemy fuel), and the completion premium shrinks with what I have left to build with. Game muwp487y t106: d4 Kai offered $760 + Connecticut for Park Place to a human holding $62 and built pinks. Its own valuation of that deal was -485 (break-even ~$530), the human\'s modelled accept point ~$450, and Kai never built the dark blues it bought while the human hotel\'d six tiles. 2 (default) = toward a CPU partner, solve both edges of the zone on the real utility curve (bisection) and use it as the zone; toward a HUMAN partner, price-only as in 1; 3 = the solved zone for humans too (not A/B-able: sims have no humans); 1 = price-only, toward a HUMAN partner only: the same deals are proposed, but where the real curve shows the CPU overpaying it pays the curve\'s lower price (Kai t106: $750 -> $440), it never asks a person for less than the old ask, and an empty/thin real zone falls back to the old price rather than dropping the deal — CPU-to-CPU play is byte-identical; 0 = the old linear zone. A replay of 152 recorded CPU deals showed the solved zone drops 18 (12%), including real set completions (mulj1n8y t74 Casey\'s green) — the E25 risk — but the 2026-10-06 A/B (E47 run, 135 cells, CPU partners) was win-positive everywhere: d5 win +0.5/+0.1/+0.4 at 5p/6p/8p, capWin +1.5 at 8p in 9/9 cells, dev% up, cash per trade -$21-25, 6p/8p games 4-8% shorter.' };
        reg['evaluator.exploitPostTradeCash'] = { def: 1, min: 0, max: 2, step: 1, label: 'Handover penalty sees post-trade cash', group: 'Evaluator',
            desc: 'Correctness fix (E46). The penalty for handing an opponent a colour set scales with how well they can build on it (exploitability), which read their cash BEFORE the trade, so cash paid to them in the same deal did not count as build money (game muwp487y t106: the human at $62 read as 0.73-funded for light blue, 1.0 with the $760 counted). 1 (default) = toward a HUMAN counterparty only, and only cash paid TO them counts (cash a human pays the CPU never makes handing them a set look cheaper; the symmetric form flipped mse3hmqt t75 Dana selling Illinois to the eventual winner from -19 to +64) — CPU-only play byte-identical; 2 = both directions, every counterparty (A/B 2026-10-06, E47 run: d5 capWin -1.7 at 5p in 0/9 cells up, d5 win -0.9 at 6p in 8/9 cells down — rejected); 0 = the old pre-trade read.' };
        reg['evaluator.mutualDevelopParity'] = { def: 0, min: 0, max: 2, step: 0.5, label: 'Mutual completion: weigh who can build first', group: 'Evaluator',
            desc: 'E48 (closed: A/B 20261007-0256, doses 1/2 win-neutral to slightly negative — 5p capWin −1.4 at 2 — and swaps barely move; keep 0). When one swap completes a colour set for BOTH sides, the handover penalty is damped to 25% (mutualAdvanceDamp, lead-scaled by E16) as if the two sets were equal. Game muxf4uxb t104: d4 Reese gave d5 Tate orange + $390 for Boardwalk; Tate (exploitability 1.0, paid to build $100 houses) hotel\'d orange while Reese ($734 left, 0.68 for $200-house dark blue) built two houses and was bankrupted by orange. >0 lifts the damping back toward the full penalty by (partner\'s build funding - mine) x this x skill, both on post-trade cash; the cash leg then gets steeper as I pay more. 0 (default) = off.' };
        reg['evaluator.mutualDevSpeed'] = { def: 4, min: 0, max: 10, step: 1, label: 'Mutual completion: development race (rounds)', group: 'Evaluator',
            desc: 'E49. When one trade completes a colour set for BOTH sides, the handover penalty is priced on the set\'s face value (and damped to 25%), as if the two sets were equal. They aren\'t when one owner can build theirs up at once: game mv2jir3q t86, d4 Bailey completed $200-house green on $692 while handing the human $50-house light blue, which T hotel\'d three turns later; Bailey died paying light-blue hotel rent. E48 (mutualDevelopParity) only lifted the damping, which still prices light blue at ~$320, so it could not flip that trade. This charges the gap in expected rent between the two new sets, each built evenly to the level its owner can fund right after the trade (post-trade cash + half spare mortgage equity, bank stock capped), times opponents x this many table rounds x skill. Value = horizon in rounds; 0 = off. Where it applies: evaluator.mutualDevSpeedScope.' };
        reg['evaluator.mutualDevSpeedScope'] = { def: 1, min: 1, max: 3, step: 1, label: 'Development-race scope', group: 'Evaluator',
            desc: 'Where evaluator.mutualDevSpeed applies. 1 = trades with a HUMAN partner only (CPU-only play byte-identical; the E44/E45/E47 pattern, since the motivating trades are human-won: mv2jir3q t86, plus Ash t83 and Alex t133 in earlier reviews). 2 = every partner (the form sims can A/B). 3 = human partners, plus every partner when the deciding CPU is d5 (a top-difficulty lever: d5 reads the race in CPU play too, d1-d4 do not).' };
        reg['evaluator.tradeNagFix'] = { def: 1, min: 0, max: 1, step: 1, label: 'Rejected counters count as refusals', group: 'Evaluator',
            desc: 'Fix for a trade nag loop the refusal ledger (tradeRefusalCap, E31) missed. The ledger only recorded a refusal when the owner REJECTED an ask; when the owner COUNTERED and the asker turned the counter down, nothing was recorded, so the asker re-asked the same tile every ~16 turns all game (game mv2jir3q: d5 Lane bid $210 for States six times, Gray countered $290 each time). 1 = a rejected counter records a refusal against the tiles originally asked for, so the usual backoff and 3-refusal cap apply. (Filtering the entry buyer away from owners\' near-set tiles was tried and dropped: on maximally-blocked boards such as mud9g25d t160 every remaining 3-tile group is a near-set or a pure block, so it switched E43 off entirely.) 0 = the old behavior.' };
        reg['evaluator.liquidityPenaltyMode'] = { def: 2, min: 0, max: 2, step: 1, label: 'Liquidity penalty counts only the trade\'s own shortfall', group: 'Evaluator',
            desc: 'E47. Trade utility charges 1.2x for every dollar a trade leaves me below my cash floor, but it measured the whole shortfall, so a CPU ALREADY below its floor paid that penalty on every offer, even one that costs it no cash (game muoxzvh6 t157: d3 Noel at $247 vs floor $390 scored a FREE Baltic at -17, including a constant -171.6, and countered asking for $30). 2 (default) = charge only the extra shortfall the trade itself causes (no bonus for trades that raise cash), on trades with a HUMAN counterparty only — CPU-only play byte-identical; 1 = the same for every counterparty (A/B 2026-10-06, 135 cells: d5 win -1.2 ±0.9 at 6p in 7/9 cells down, 5p games 10% longer, ping-pong 2.2 -> 4.1% — CPUs trade more with each other and d5 loses its edge; rejected); 0 = the old absolute charge.' };
        reg['evaluator.shutoutEntryPremium'] = { def: 0.5, min: 0, max: 1, step: 0.25, label: 'Shut-out re-entry premium', group: 'Evaluator',
            desc: 'd3+ CPUs holding NO colour deed on a board with none left in the bank had no trade line back in: every buy generator keys off tiles they already own, so they idled their cash until rent attrition killed them (game mud9g25d: d4 Bailey, ~236 turns deedless on $1300-1700 with 0 proposals; the same shape in earlier 7-8p games). When >0 such a CPU offers cash for an opponent\'s lone colour single as a foothold, valuing the entry at this fraction of the tile\'s price on top of its normal value (a lone single is worth about face to both sides, so without a premium there is no deal to find). It keeps 1.5x its cash floor. A/B 2026-09-30 (E43, 54 cells 5p/6p/8p): win-neutral for d5 everywhere (within ±0.5); at 8p shut-out entries 5.9 → 24.5 per 100 games and entrants win 5% (was 1%). 1.0 added re-trading and 2% longer games for nothing, so the default is 0.5 — a play-realism fix. 0 = off.' };
        reg['evaluator.blockTransferShare'] = { def: 0.5, min: 0, max: 1, step: 0.25, label: 'Blocker premium kept on third-party transfer', group: 'Evaluator',
            desc: 'A tile that blocks an opponent\'s colour set (they hold the rest of the group) is valued at up to 2.2x its normal worth. That is right when the block is NEW (buying it from the bank), but in a trade with a THIRD party the block already exists and only changes hands: the set stays split either way. This is the fraction of the blocker premium still counted when a trade moves a blocker between two players neither of whom is the blocked opponent (both when receiving and when giving one away). Selling a blocker TO the blocked opponent is unaffected (still full premium plus the monopoly-handover penalty). Game mud9g25d t193: d5 Ira valued T\'s Boardwalk (vs Reese) and North Carolina (vs Lennon) at +$605 of blocker premium and handed T the red set; at 0.5 it rejects. 1 = the old behavior (full premium). Where it applies is set by evaluator.blockTransferScope (default: only when receiving from a human). SHIPPED 0.5, human-scoped (E44, 2026-09-30): the all-partner form was not a win lever and cost 6p d5 −1.0/−1.4 in a 135-cell A/B; the human-scoped form leaves CPU-only play byte-identical and, across 82 recorded games, changes only the t193-style trades.' };
        reg['evaluator.blockTransferScope'] = { def: 1, min: 0, max: 1, step: 1, label: 'Blocker-transfer discount scope', group: 'Evaluator',
            desc: 'Where evaluator.blockTransferShare applies. 1 = only when a CPU RECEIVES a blocker from a HUMAN (the exploited pattern, game mud9g25d t193); CPU-to-CPU trades and giving a blocker away keep the full premium (a human who receives a block can resell it to the blocked player). 0 = any third-party trade, both sides — the form A/B\'d in E44 (135 cells): not a win lever, 6p d5 −1.0/−1.4, because every CPU got the same discount and it helped d4 as much as d5.' };
        reg['evaluator.lookaheadHandoverVeto'] = { def: 2, min: 0, max: 2, step: 1, label: 'Lookahead may not accept a set handover', group: 'Evaluator',
            desc: 'd5 only (the lookahead tier). When d5\'s rollout check says ACCEPT a trade its valuation rejected, it normally wins unless the valuation is far below the threshold (half the traded face value, so the bigger the package the wider the band it can override). The rollout scores deeds at face plus a flat half-price bonus for a completed set, and looks only ~4 turns ahead, so "I get more face value, you get a monopoly" reads as a win before the houses go up. With this on, the rollout may not overturn a reject when the offer completes a colour set for the proposer (1 = any proposer; 2 = human proposers only, so all-CPU play is unchanged). Game mud9g25d t193: d5 Ira handed T the red set via "lookahead overrides to accept". 0 = off (old). SHIPPED at 2 (E45, 2026-09-30): level 1 was win-neutral in a 153-cell A/B (5p +0.7, 6p −0.8, 8p −0.3, h2h +0.5); level 2 leaves CPU-only play unchanged and, in recorded games, turns d5 Yuri\'s light-blue giveaway (mrwwyngr t93, T won) into a counter.' };
        reg['difficulty.4.auctionSmarts'] = { def: (diff[4] && diff[4].auctionSmarts != null) ? diff[4].auctionSmarts : 0.5, min: 0, max: 1, step: 0.5, label: 'd4 auction smarts', group: 'Difficulty',
            desc: 'd4\'s auction sophistication tier. Default 0.5 (2026-07-29 ladder re-spacing): the sharp-auction branches (price-anchored bidding + bluff-drain) are d5-EXCLUSIVE. Set to 1 to restore the old d4 behavior where d4 auctioned exactly like d5. Only d4\'s is exposed: this is a ladder-spacing lever (d5 keeps 1, d3 is already below the gate).' };
        this._registry = reg;
        this._overrides = StorageManager.get(STORAGE_KEYS.AI_TUNING, null) || {};
    },

    registry() {
        this._ensure();
        return this._registry;
    },

    get(path, def) {
        this._ensure();
        const v = this._overrides[path];
        if (typeof v === 'number' && isFinite(v)) return v;
        const entry = this._registry[path];
        return entry ? entry.def : def;
    },

    /** Merge live values for every key of `base` under `prefix` (memoized;
     *  keys outside the registry pass through unchanged). */
    merged(prefix, base) {
        this._ensure();
        if (this._merged[prefix]) return this._merged[prefix];
        const out = {};
        Object.keys(base).forEach(k => { out[k] = this.get(`${prefix}.${k}`, base[k]); });
        this._merged[prefix] = out;
        return out;
    },

    set(path, value) {
        this._ensure();
        const entry = this._registry[path];
        if (!entry) return false;
        value = Math.max(entry.min, Math.min(entry.max, Number(value)));
        if (!isFinite(value)) return false;
        if (value === entry.def) delete this._overrides[path];
        else this._overrides[path] = value;
        this._persist();
        return true;
    },

    reset(path) {
        this._ensure();
        if (path) delete this._overrides[path];
        else this._overrides = {};
        this._persist();
    },

    /** Sparse map of non-default values (recorded into new game records). */
    overrides() {
        this._ensure();
        return { ...this._overrides };
    },

    /**
     * Rules that treat a HUMAN trade partner differently from a CPU one: the
     * human-scoped levers (E44-E49 pattern, shipped human-only because the
     * all-partner form lost in CPU-only A/Bs) plus the fixed assumptions CPUs
     * use to model a human. Sims have no humans, so none of these show up in
     * an A/B; their evidence is decision replays of recorded games. Listed in
     * the Sim Lab "Human-only" view. Add an entry here with every new
     * human-scoped knob.
     *
     * Each entry: effort, title, who (difficulties it reaches), knobs, and
     * state(get) -> { scope: 'human'|'all'|'off'|'human+', text } — the rule
     * as the CURRENT settings (defaults + overrides) apply it.
     */
    HUMAN_RULES: [
        {
            effort: 'E44', title: 'Blockers you sell a CPU are discounted', who: 'd1–d5',
            knobs: ['evaluator.blockTransferShare', 'evaluator.blockTransferScope'],
            state(get) {
                const share = get('evaluator.blockTransferShare'), scope = get('evaluator.blockTransferScope');
                if (share >= 1) return { scope: 'off', text: 'Off: a blocker keeps its full premium in every trade.' };
                const pct = Math.round(share * 100);
                if (!scope) return { scope: 'all', text: `Any trade that moves a set-blocking tile between two players other than the blocked one counts ${pct}% of the blocker premium, for every partner.` };
                return { scope: 'human', text: `When a CPU receives from you a tile that blocks a third player's colour set, it counts only ${pct}% of the blocker premium (the block already exists; it only changes hands). Giving you a blocker, and CPU-to-CPU trades, keep the full premium.` };
            }
        },
        {
            effort: 'E45', title: 'Lookahead cannot accept handing you a set', who: 'd5',
            knobs: ['evaluator.lookaheadHandoverVeto'],
            state(get) {
                const v = get('evaluator.lookaheadHandoverVeto');
                const rule = 'When a d5\'s valuation rejects an offer that completes a colour set for the proposer, its lookahead simulation may not overturn that into an accept.';
                if (!v) return { scope: 'off', text: 'Off: the lookahead may overturn any reject.' };
                if (v === 1) return { scope: 'all', text: rule + ' Applies to every proposer.' };
                return { scope: 'human', text: rule + ' Applies only when you are the proposer.' };
            }
        },
        {
            effort: 'E46', title: 'Cash offers to you: price-only exact pricing', who: 'd1–d5',
            knobs: ['evaluator.zopaExactCash'],
            state(get) {
                const v = get('evaluator.zopaExactCash');
                if (!v) return { scope: 'off', text: 'Off: every partner gets the old linear cash zone.' };
                if (v >= 3) return { scope: 'all', text: 'You get the same solved cash zone as CPU partners.' };
                return { scope: 'human', text: 'When a CPU puts cash in an offer to you, it checks the price on its real utility curve: where it was overpaying, it pays the lower price, but it never asks you for less than before and never drops a deal because the real zone is thin.' +
                    (v === 2 ? ' CPU partners get the full solved zone instead (cheaper offers that are sometimes refused).' : ' CPU partners keep the old linear zone.') };
            }
        },
        {
            effort: 'E46', title: 'Cash paid to you counts as your build money', who: 'd1–d5',
            knobs: ['evaluator.exploitPostTradeCash'],
            state(get) {
                const v = get('evaluator.exploitPostTradeCash');
                if (!v) return { scope: 'off', text: 'Off: the handover penalty reads your cash before the trade.' };
                if (v === 2) return { scope: 'all', text: 'The set-handover penalty counts post-trade cash in both directions, for every partner.' };
                return { scope: 'human', text: 'When a CPU weighs handing you a colour set, cash it pays you in the same trade counts as money you can build with. Cash you pay it never makes the handover look cheaper.' };
            }
        },
        {
            effort: 'E47', title: 'Liquidity charge counts only the trade\'s own shortfall', who: 'd1–d5',
            knobs: ['evaluator.liquidityPenaltyMode'],
            state(get) {
                const v = get('evaluator.liquidityPenaltyMode');
                if (!v) return { scope: 'off', text: 'Off: the whole cash-reserve shortfall is charged on every trade.' };
                const rule = 'A CPU already below its cash reserve is charged only for the extra shortfall the trade itself causes, not the whole gap, so a free tile no longer scores negative.';
                return v === 1 ? { scope: 'all', text: rule + ' Applies to every partner.' }
                               : { scope: 'human', text: rule + ' Applies only to trades with you; CPU-to-CPU trades keep the absolute charge.' };
            }
        },
        {
            effort: 'E49', title: 'Mutual completions price the development race', who: 'd2–d5 (scales with skill)',
            knobs: ['evaluator.mutualDevSpeed', 'evaluator.mutualDevSpeedScope'],
            state(get) {
                const rounds = get('evaluator.mutualDevSpeed'), scope = get('evaluator.mutualDevSpeedScope');
                if (!rounds) return { scope: 'off', text: 'Off: both new sets are priced at face value.' };
                const rule = `When a trade completes a colour set for both sides, the CPU charges the gap in rent between your new set and its own, each built to the level its owner can fund right after the trade, × opponents × ${rounds} rounds.`;
                if (scope === 2) return { scope: 'all', text: rule + ' Applies to every partner.' };
                if (scope === 3) return { scope: 'human+', text: rule + ' Applies to trades with you, and a d5 also applies it to CPU partners.' };
                return { scope: 'human', text: rule + ' Applies only to trades with you.' };
            }
        },
        {
            effort: 'E42', title: 'CPUs model you at a fixed skill', who: 'd1–d5', knobs: [],
            state() {
                return { scope: 'human', text: 'When pricing an offer to you, a CPU predicts your valuation at a flat skill of 0.75 (a CPU partner is read at its own difficulty).' };
            }
        },
        {
            effort: null, title: 'CPUs expect you to want a 5% edge', who: 'd1–d5', knobs: [],
            state() {
                return { scope: 'human', text: 'When pricing an offer to you, a CPU assumes you want 5% in your favour before accepting (a CPU partner is read at its difficulty\'s trade margin). Bot trade flexibility in Settings scales this.' };
            }
        }
    ],

    /** HUMAN_RULES evaluated against the live settings. */
    humanRules() {
        this._ensure();
        const get = path => this.get(path);
        return this.HUMAN_RULES.map(r => ({
            effort: r.effort, title: r.title, who: r.who,
            knobs: r.knobs.map(path => {
                const entry = this._registry[path];
                return { path, label: entry ? entry.label : path, value: this.get(path),
                         def: entry ? entry.def : undefined, overridden: path in this._overrides };
            }),
            ...r.state(get)
        }));
    },

    _persist() {
        this._merged = {};
        if (Object.keys(this._overrides).length) {
            StorageManager.set(STORAGE_KEYS.AI_TUNING, this._overrides);
        } else {
            StorageManager.remove(STORAGE_KEYS.AI_TUNING);
        }
    }
};

if (typeof window !== 'undefined') {
    window.AITuning = AITuning;
}
