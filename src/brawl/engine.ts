// Street Brawl draft engine. Pure function of (hero assets, item catalog, Street Brawl aggregate analytics,
// mode config). Everything in the draft is free and the order is fixed by round, so unlike the normal-mode
// generator there is no cost-efficiency or buy-time term. It never reads per-player data.
import type { Item, ItemStat } from '../types';
import { statValue } from '../generator/build';
import { kitProfile } from '../generator/kit';
import type { BrawlInput, DraftAdvice, DraftState, Offer, RankedOffer, RerollAdvice, ScoreParts } from './types';

// tier: popularity and win-lift are normalised within a tier (see baseScores), so the within-tier score spread is
// about 0.2 (worst) .. 1.4 (best) for every tier and carries no cross-tier information. A rare card is a whole tier
// above the rest of its set, and everything in the draft is free, so one tier is worth about the whole within-tier
// spread: a median tier-3 card beats the best tier-2 card, and only a tier-3 card that is useless for the hero loses
// to a top tier-2 pick.
// enhanced: the same item with better numbers, worth a good part of a tier. Both the enhanced flag and the rare
// (tier-bumped) flag belong to the card slot and survive a re-roll: a re-roll of an enhanced slot yields another
// enhanced card and a re-roll of a rare slot yields another rare-tier card (see cardDist). So a weak rare or enhanced
// card is often worth re-rolling: the slot keeps its bonus and only the item is drawn again.
export const BRAWL_WEIGHTS = {
  popularity: 1.0,
  winLift: 1.0,
  kit: 0.3,
  tier: 1.0,
  counter: 0.5,
  synergy: 0.5,
  active: 0.1,
  upgrade: 0.15,
  enhanced: 0.6,
  dup: 1.0,
};
export const WIN_SHRINK_FRAC = 0.05; // K = max(200, 5 % of the tier's most-picked item)
export const MIN_PAIR_MATCHES = 20;
export const MIN_VS_MATCHES = 50; // enemy-filtered rows below this are ignored
export const ENHANCED_STAT_MULT = 1.25; // UNVERIFIED: the API does not publish enhanced numbers; measure from tooltips
export const MAX_ACTIVES = 4; // Brawl keeps the 4-active cap (no per-slot caps); a 5th active gets a penalty, not a veto
export const ACTIVE_OVERFLOW_PENALTY = 0.5;
export const REROLL_GAIN_THRESHOLD = 0; // re-roll whenever a fresh draw is expected to beat the set's best card
// Per-card rare / enhanced chance as seen on screen: 4 rare and 3 enhanced of the 27 fixture cards
// (scripts/fixtures/brawl-cards/labels.json). The config's outcome-weight tables give 0.39 and 0.26 per card if read as
// counts over the nine cards of a round, which is far above what the draft shows and made a fresh set look better
// than the best card of its tier; whatever those tables count, it is not that. Set either to null to use the config.
export const RARE_PER_CARD: number | null = 4 / 27;
export const ENHANCED_PER_CARD: number | null = 3 / 27;
export const CARDS_PER_SET = 3;
export const SETS_PER_ROUND = 3;

export interface Base {
  item: Item;
  stat?: ItemStat;
  pop: number;
  winLift: number;
  kit: number;
  base: number;
  counter: number;
}

/** Items that can appear on a draft card. */
export const draftable = (i: Item) => !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name);

const shrink = (wins: number, matches: number, K: number, mean: number) => (wins + K * mean) / (matches + K);

/**
 * Per-item scores independent of the draft state. Popularity and win-lift are normalised WITHIN TIER:
 * a tier-4 item is picked less often than a tier-1 item mostly because it is offered less often (tier
 * pools are fixed per round), so cross-tier usage says little about quality. Kit value is the raw
 * soul-equivalent stat value (no cost division: everything is free) relative to the tier median, clipped at
 * 2x. The per-tier bonus (BRAWL_WEIGHTS.tier) is what compares a rare (tier-bumped) card with the normal cards of
 * its set: the within-tier terms only say how good a card is among its own tier.
 */
export function baseScores(input: BrawlInput, enemies: number[] = []): Map<number, Base> {
  const { hero, abilities, items, analytics } = input;
  const catalog = new Map(items.filter(draftable).map((i) => [i.id, i]));
  const kit = kitProfile(hero, abilities);
  const stats = new Map(
    analytics.item_stats.filter((s) => catalog.has(s.item_id) && s.matches > 0).map((s) => [s.item_id, s]),
  );
  const tierMax: Record<number, number> = {};
  for (const s of stats.values()) {
    const t = catalog.get(s.item_id)!.item_tier;
    tierMax[t] = Math.max(tierMax[t] ?? 0, s.matches);
  }
  const totalW = [...stats.values()].reduce((a, s) => a + s.wins, 0),
    totalM = [...stats.values()].reduce((a, s) => a + s.matches, 0);
  const meanWR = totalM ? totalW / totalM : 0.5;

  // enemy-filtered populations: per enemy, the hero's mean win rate in those matches
  const vsMean = new Map<number, number>();
  for (const e of enemies) {
    const rows = analytics.vs[String(e)];
    if (!rows) continue;
    const w = rows.reduce((a, r) => a + r.wins, 0),
      m = rows.reduce((a, r) => a + r.matches, 0);
    if (m) vsMean.set(e, w / m);
  }

  // kit value: unknown (unpriced) items get the median of their tier so the term is neutral for them
  const rawKit = new Map<number, number>();
  for (const it of catalog.values()) rawKit.set(it.id, statValue(it, kit));
  const tierMedian: Record<number, number> = {};
  for (const t of [1, 2, 3, 4, 5]) {
    const xs = [...catalog.values()]
      .filter((i) => i.item_tier === t)
      .map((i) => rawKit.get(i.id)!)
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    tierMedian[t] = xs.length ? xs[Math.floor(xs.length / 2)] : 0;
  }
  const kitVal = (it: Item) => (rawKit.get(it.id)! > 0 ? rawKit.get(it.id)! : (tierMedian[it.item_tier] ?? 0));
  const kitNorm = (it: Item) => {
    const med = tierMedian[it.item_tier];
    return med ? Math.min(2, kitVal(it) / med) / 2 : 0.5;
  };

  const out = new Map<number, Base>();
  for (const it of catalog.values()) {
    const stat = stats.get(it.id);
    const tm = tierMax[it.item_tier] ?? 0;
    const pop = stat && tm ? stat.matches / tm : 0;
    const K = Math.max(200, WIN_SHRINK_FRAC * tm);
    const winLift = stat ? (shrink(stat.wins, stat.matches, K, meanWR) - meanWR) * 10 * pop : 0;
    // counter: how much better the item does against the known enemies than against the field
    let counter = 0,
      n = 0;
    if (stat)
      for (const e of enemies) {
        const rows = analytics.vs[String(e)];
        const mean = vsMean.get(e);
        if (!rows || mean === undefined) continue;
        const r = rows.find((x) => x.item_id === it.id);
        if (!r || r.matches < MIN_VS_MATCHES) continue;
        const liftVs = shrink(r.wins, r.matches, K, mean) - mean;
        const liftAll = shrink(stat.wins, stat.matches, K, meanWR) - meanWR;
        counter += (liftVs - liftAll) * 10 * pop;
        n++;
      }
    counter = n ? counter / n : 0;
    const k = kitNorm(it);
    const base =
      BRAWL_WEIGHTS.popularity * Math.sqrt(pop) +
      BRAWL_WEIGHTS.winLift * winLift +
      BRAWL_WEIGHTS.kit * k +
      BRAWL_WEIGHTS.tier * (it.item_tier - 1) +
      (it.is_active_item ? BRAWL_WEIGHTS.active : 0);
    out.set(it.id, { item: it, stat, pop, winLift, kit: k, base, counter });
  }
  return out;
}

/** Pair win-lift lookup (×10) from Street Brawl permutation stats. */
export function pairLifts(input: BrawlInput): Map<string, number> {
  const stats = input.analytics.item_stats;
  const totalW = stats.reduce((a, s) => a + s.wins, 0),
    totalM = stats.reduce((a, s) => a + s.matches, 0);
  const meanWR = totalM ? totalW / totalM : 0.5;
  const pair = new Map<string, number>();
  for (const p of input.analytics.permutation_stats) {
    if (p.item_ids.length !== 2 || p.matches < MIN_PAIR_MATCHES) continue;
    const lift = (p.wins / p.matches - meanWR) * 10;
    const [a, b] = p.item_ids;
    pair.set(`${a}:${b}`, lift);
    pair.set(`${b}:${a}`, lift);
  }
  return pair;
}

const synergyWith = (pair: Map<string, number>, id: number, others: number[]) => {
  let s = 0,
    n = 0;
  for (const o of others) {
    const l = pair.get(`${id}:${o}`);
    if (l !== undefined) {
      s += l;
      n++;
    }
  }
  return n ? s / n : 0;
};

/** Scores one card against the current state (owned items, enemies) without considering the other sets. */
export function scoreOffer(
  input: BrawlInput,
  bases: Map<number, Base>,
  pair: Map<string, number>,
  state: DraftState,
  offer: Offer,
): RankedOffer {
  const b = bases.get(offer.itemId);
  const item = b?.item ?? input.items.find((i) => i.id === offer.itemId);
  if (!item) throw new Error(`unknown item id ${offer.itemId}`);
  const ownedItems = state.owned.map((id) => input.items.find((i) => i.id === id)).filter((x): x is Item => !!x);
  const enhanced = !!offer.enhanced;
  const synergy = synergyWith(pair, item.id, state.owned);
  const upgradesOwned = ownedItems.some((o) => item.component_items.includes(o.class_name));
  const actives = ownedItems.filter((o) => o.is_active_item).length;
  const activePenalty = item.is_active_item && actives >= MAX_ACTIVES ? -ACTIVE_OVERFLOW_PENALTY : 0;
  const dup = state.owned.includes(item.id);
  const parts: ScoreParts = {
    pop: b ? BRAWL_WEIGHTS.popularity * Math.sqrt(b.pop) : 0,
    winLift: b ? BRAWL_WEIGHTS.winLift * b.winLift : 0,
    kit: b ? BRAWL_WEIGHTS.kit * b.kit * (enhanced ? ENHANCED_STAT_MULT : 1) : 0,
    tier: BRAWL_WEIGHTS.tier * (item.item_tier - 1),
    counter: b ? BRAWL_WEIGHTS.counter * b.counter : 0,
    synergy: BRAWL_WEIGHTS.synergy * synergy,
    active: (item.is_active_item ? BRAWL_WEIGHTS.active : 0) + activePenalty,
    upgrade: upgradesOwned ? BRAWL_WEIGHTS.upgrade : 0,
    enhanced: enhanced ? BRAWL_WEIGHTS.enhanced : 0,
    dup: dup ? -BRAWL_WEIGHTS.dup : 0,
  };
  const score = Object.values(parts).reduce((a, x) => a + x, 0);
  const why: string[] = [];
  const hero = input.hero.name;
  if (!b?.stat) why.push('no Street Brawl data for this item yet');
  if (b && b.pop > 0.5)
    why.push(
      `picked in ${(b.pop * 100).toFixed(0)}% of ${hero} brawls (relative to the top tier-${item.item_tier} pick)`,
    );
  if (b && b.winLift > 0.1) why.push(`+${(b.winLift * 10).toFixed(1)}% win rate vs ${hero} average`);
  if (b && b.winLift < -0.1) why.push(`${(b.winLift * 10).toFixed(1)}% win rate vs ${hero} average`);
  if (b && b.kit > 0.7) why.push(`scales ${hero}'s kit`);
  if (b && b.counter > 0.1) why.push('wins more against this enemy team');
  if (b && b.counter < -0.1) why.push('wins less against this enemy team');
  if (synergy > 0.2) why.push('wins more alongside items you already hold');
  if (synergy < -0.2) why.push('wins less alongside items you already hold');
  if (upgradesOwned)
    why.push(
      `upgrades ${ownedItems.find((o) => item.component_items.includes(o.class_name))!.name}, which you already hold`,
    );
  if (activePenalty) why.push(`you already hold ${actives} active items`);
  if (enhanced) why.push('enhanced version');
  if (dup) why.push('you already hold this item');
  return {
    item,
    enhanced,
    score,
    parts,
    why,
    usage: b?.pop ?? 0,
    winRate: b?.stat ? b.stat.wins / b.stat.matches : null,
    known: !!b?.stat,
  };
}

/** Rare (tier-bumped) chance per card: the measured constant, else the config's outcome-count weight table. */
export function rareChancePerCard(input: BrawlInput, round: number): number {
  if (RARE_PER_CARD !== null) return RARE_PER_CARD;
  const r =
    input.config.item_draft_rounds_per_game_round[
      Math.min(round, input.config.item_draft_rounds_per_game_round.length) - 1
    ];
  if (!r) return 0;
  let w = 0,
    ew = 0;
  for (const [k, v] of Object.entries(r.chance_rare.outcomes_to_weights)) {
    w += v;
    ew += Number(k) * v;
  }
  const cards = r.item_draft_rounds.length * CARDS_PER_SET;
  return w ? Math.min(1, ew / w / cards) : 0;
}

/** Enhanced chance per card: the measured constant, else the config's outcome-count weight table. */
export function enhancedChancePerCard(input: BrawlInput, round: number): number {
  if (ENHANCED_PER_CARD !== null) return ENHANCED_PER_CARD;
  const r =
    input.config.item_draft_rounds_per_game_round[
      Math.min(round, input.config.item_draft_rounds_per_game_round.length) - 1
    ];
  if (!r) return 0;
  let w = 0,
    ew = 0;
  for (const [k, v] of Object.entries(r.chance_enhanced.outcomes_to_weights)) {
    w += v;
    ew += Number(k) * v;
  }
  const cards = r.item_draft_rounds.length * CARDS_PER_SET;
  return w ? Math.min(1, ew / w / cards) : 0;
}

export interface Dist {
  s: number;
  w: number;
}

/**
 * Score distribution of one fresh card in a given set: every draftable item of the set's normal tier (rare tier with
 * probability pRare), weighted uniformly within the tier. Items with no Street Brawl data are in the pool too (they
 * are offered just as often; they only score their tier and kit value). `enhanced` is the slot's flag when known
 * (it survives a re-roll); null draws it with the round's enhanced chance. `rare` likewise fixes the slot's tier bump
 * (a rare slot re-rolls into another rare-tier card, a normal slot into a normal one); null draws it with the round's
 * rare chance. `actives` applies the overflow penalty.
 */
export function cardDist(
  input: BrawlInput,
  bases: Map<number, Base>,
  round: number,
  setIndex: number,
  enhanced: boolean | null,
  actives = 0,
  rare: boolean | null = null,
): Dist[] | null {
  const r =
    input.config.item_draft_rounds_per_game_round[
      Math.min(round, input.config.item_draft_rounds_per_game_round.length) - 1
    ];
  const tiers = r?.item_draft_rounds[setIndex];
  if (!tiers) return null;
  const pRare = rare === null ? rareChancePerCard(input, round) : rare ? 1 : 0;
  const pEnh = enhanced === null ? enhancedChancePerCard(input, round) : enhanced ? 1 : 0;
  const out: Dist[] = [];
  for (const [tier, p] of [
    [tiers.normal_mod_tier, 1 - pRare],
    [tiers.rare_mod_tier, pRare],
  ] as const) {
    if (p <= 0) continue;
    const xs = [...bases.values()].filter((b) => b.item.item_tier === tier);
    for (const b of xs) {
      const pen = b.item.is_active_item && actives >= MAX_ACTIVES ? -ACTIVE_OVERFLOW_PENALTY : 0;
      const plain = b.base + pen;
      const enh = b.base + pen + BRAWL_WEIGHTS.enhanced + BRAWL_WEIGHTS.kit * b.kit * (ENHANCED_STAT_MULT - 1);
      if (pEnh < 1) out.push({ s: plain, w: (p / xs.length) * (1 - pEnh) });
      if (pEnh > 0) out.push({ s: enh, w: (p / xs.length) * pEnh });
    }
  }
  return out.length ? out : null;
}

/** Distribution of the maximum of independent draws, one per slot: P(max ≤ v) = Π_j F_j(v). */
export function maxDist(slots: Dist[][]): Dist[] {
  const values = [...new Set(slots.flat().map((d) => d.s))].sort((a, b) => a - b);
  const sorted = slots.map((sl) => [...sl].sort((a, b) => a.s - b.s));
  const idx = slots.map(() => 0),
    F = slots.map(() => 0);
  const out: Dist[] = [];
  let prev = 0;
  for (const v of values) {
    let G = 1;
    for (let j = 0; j < sorted.length; j++) {
      while (idx[j] < sorted[j].length && sorted[j][idx[j]].s <= v) F[j] += sorted[j][idx[j]++].w;
      G *= F[j];
    }
    if (G - prev > 0) out.push({ s: v, w: G - prev });
    prev = G;
  }
  return out;
}

export const mean = (d: Dist[]) => d.reduce((a, x) => a + x.s * x.w, 0);

/**
 * Expected best score of a fresh set of 3 cards. `enhanced` and `rare` give the slots' flags when the set is on screen
 * (a re-roll keeps both); when the set is still unseen, every slot draws them at the round's chances.
 */
export function expectedBestOfSet(
  input: BrawlInput,
  bases: Map<number, Base>,
  round: number,
  setIndex: number,
  enhanced: (boolean | null)[] = [null, null, null],
  actives = 0,
  rare: (boolean | null)[] = enhanced.map(() => null),
): (RerollAdvice['pool'] & { expected: number; dist: Dist[] }) | null {
  const r =
    input.config.item_draft_rounds_per_game_round[
      Math.min(round, input.config.item_draft_rounds_per_game_round.length) - 1
    ];
  const tiers = r?.item_draft_rounds[setIndex];
  if (!tiers) return null;
  const slots = enhanced.map((e, j) => cardDist(input, bases, round, setIndex, e, actives, rare[j] ?? null));
  if (slots.some((x) => !x)) return null;
  const dist = maxDist(slots as Dist[][]);
  return {
    tier: tiers.normal_mod_tier,
    rareTier: tiers.rare_mod_tier,
    pRare: rareChancePerCard(input, round),
    expected: mean(dist),
    dist,
  };
}

/** Ranks every card, chooses the jointly best pick per set, and says whether a reroll is worth it. */
export function adviseDraft(input: BrawlInput, state: DraftState): DraftAdvice {
  const bases = baseScores(input, state.enemies);
  const pair = pairLifts(input);
  const layout = roundTiers(input, state.round);
  const sets = state.sets.map((set, i) =>
    set
      .map((o) => {
        const r = scoreOffer(input, bases, pair, state, o);
        const normal = layout[i]?.normal;
        if (normal && r.item.item_tier > normal)
          r.why.unshift(`rare: a tier-${r.item.item_tier} card in a tier-${normal} set`);
        return r;
      })
      .sort((a, b) => b.score - a.score || a.item.id - b.item.id),
  );

  // joint pick: every one-per-set combination, adding pairwise synergy between the picks themselves
  let best: RankedOffer[] = [],
    bestScore = -Infinity;
  const rec = (i: number, acc: RankedOffer[]) => {
    if (i === sets.length) {
      let s = acc.reduce((a, r) => a + r.score, 0);
      for (let x = 0; x < acc.length; x++)
        for (let y = x + 1; y < acc.length; y++) {
          if (acc[x].item.id === acc[y].item.id) s -= 1; // the same item twice is a wasted pick
          s +=
            (BRAWL_WEIGHTS.synergy * (pair.get(`${acc[x].item.id}:${acc[y].item.id}`) ?? 0)) /
            Math.max(1, acc.length - 1);
        }
      if (s > bestScore) {
        bestScore = s;
        best = [...acc];
      }
      return;
    }
    if (!sets[i].length) {
      rec(i + 1, acc);
      return;
    }
    for (const r of sets[i]) rec(i + 1, [...acc, r]);
  };
  rec(0, []);

  // reroll: suggested for the set with the largest expected gain (a fresh draw's expected best minus its best card)
  // whenever that gain is positive. The on-screen slots keep their rare and enhanced flags through the re-roll, so a
  // set holding a poor rare or enhanced card is valued against a fresh draw of the same rare tier / enhanced slot,
  // which is what makes re-rolling a weak rare card worthwhile. The value of holding the re-roll for a later set is reported alongside (later sets
  // on screen have a known gain; unseen ones are valued by backward induction over the distribution of their best
  // card, V_j = E[max(gain_j, V_{j+1})]) and vetoes the re-roll when saving it is worth at least as much as re-rolling now.
  // The state-dependent terms (synergy, counter, upgrade) are stripped from the current best so it is on the pool's scale.
  let reroll: RerollAdvice | null = null;
  const rerolls =
    input.config.item_draft_rerolls_per_round[
      Math.min(state.round, input.config.item_draft_rerolls_per_round.length) - 1
    ] ?? 0;
  if (rerolls > 0) {
    const actives = state.owned
      .map((id) => input.items.find((i) => i.id === id))
      .filter((i) => i?.is_active_item).length;
    const n = layout.length;
    const known = sets.map((set, i) => {
      if (!set.length) return null;
      const flags = state.sets[i].map((o) => !!o.enhanced);
      while (flags.length < CARDS_PER_SET) flags.push(false);
      const normal = layout[i]?.normal ?? 0;
      const rares = set.map((r) => r.item.item_tier > normal);
      while (rares.length < CARDS_PER_SET) rares.push(false);
      const e = expectedBestOfSet(input, bases, state.round, i, flags, actives, rares);
      if (!e) return null;
      const currentBest = Math.max(...set.map((r) => r.score - r.parts.synergy - r.parts.counter - r.parts.upgrade));
      return {
        currentBest,
        expected: e.expected,
        gain: e.expected - currentBest,
        pool: { tier: e.tier, rareTier: e.rareTier, pRare: e.pRare },
      };
    });
    const hold: number[] = Array(n + 1).fill(0); // hold[i] = value of still having the re-roll when set i comes up
    for (let j = n - 1; j >= 0; j--) {
      const k = known[j];
      if (k) {
        hold[j] = Math.max(k.gain, hold[j + 1]);
        continue;
      }
      const e = expectedBestOfSet(input, bases, state.round, j, undefined, actives);
      hold[j] = e ? e.dist.reduce((a, d) => a + d.w * Math.max(e.expected - d.s, hold[j + 1]), 0) : hold[j + 1];
    }
    known.forEach((k, i) => {
      if (!k) return;
      if (k.gain > REROLL_GAIN_THRESHOLD && k.gain > hold[i + 1] && (!reroll || k.gain > reroll.gain))
        reroll = {
          set: i,
          currentBest: k.currentBest,
          expectedBest: k.expected,
          gain: k.gain,
          holdValue: hold[i + 1],
          pool: k.pool,
        };
    });
  }
  return { sets, picks: best, reroll };
}

/** Best few items per tier, ranked by `base` (quality within that tier, ignoring the current draft/enemies). */
export function topItemsByTier(input: BrawlInput, perTier = 3): { tier: number; items: Base[] }[] {
  const bases = [...baseScores(input).values()];
  const byTier = new Map<number, Base[]>();
  for (const b of bases) {
    const t = b.item.item_tier;
    const xs = byTier.get(t);
    if (xs) xs.push(b);
    else byTier.set(t, [b]);
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tier, xs]) => ({ tier, items: xs.sort((a, b) => b.base - a.base).slice(0, perTier) }));
}

/** Per-round tier layout of the draft, for the UI and the CLI. */
export function roundTiers(input: BrawlInput, round: number) {
  const r =
    input.config.item_draft_rounds_per_game_round[
      Math.min(round, input.config.item_draft_rounds_per_game_round.length) - 1
    ];
  return r ? r.item_draft_rounds.map((t) => ({ normal: t.normal_mod_tier, rare: t.rare_mod_tier })) : [];
}
