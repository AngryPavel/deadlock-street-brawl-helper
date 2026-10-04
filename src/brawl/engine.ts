// Street Brawl draft engine. Pure function of (hero assets, item catalog, Street Brawl aggregate analytics,
// mode config). Everything in the draft is free and the order is fixed by round, so there is no cost-efficiency or buy-time term. It never reads per-player data.
import type { Item, ItemStat } from '../types';
import { buildStatMultipliers, counterMarginal, kitProfile, statContributions, statValue } from './kit';
import {
  heroBaseline,
  historicalPrior,
  roundStatsAvailable,
  smoothedRate,
  validCounts,
} from '../local/scoringEvidence';
import { createUniformDropDistribution } from '../local/dropDistribution';
import { evaluateReroll } from '../local/rerollModel';
import type { BrawlInput, DraftAdvice, DraftState, Offer, RankedOffer, RerollAdvice, ScoreParts } from './types';

// tier: popularity and win-lift are normalised within a tier (see baseScores), so the within-tier score spread is
// about 0.2 (worst) .. 1.4 (best) for every tier and carries no cross-tier information. A rare card is a whole tier
// above the rest of its set, and everything in the draft is free, so one tier is worth about the whole within-tier
// spread: a median tier-3 card beats the best tier-2 card, and only a tier-3 card that is useless for the hero loses
// to a top tier-2 pick.
// enhanced: the same item with better numbers, worth a good part of a tier. Both the enhanced flag and the rare
// (tier-bumped) flag belong to the card slot and survive a re-roll: a re-roll of an enhanced slot yields another
// enhanced card and a re-roll of a rare slot yields another rare-tier card (see local/rerollModel). So a weak rare or enhanced
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
const WIN_SHRINK_FRAC = 0.05; // K = max(200, 5 % of the tier's most-picked item)
const MIN_VS_MATCHES = 50; // enemy-filtered rows below this are ignored
const ENHANCED_STAT_MULT = 1.25; // Explicit fallback assumption; EnhancedScoring can replace this or supply properties.
const MAX_ACTIVES = 4; // Brawl keeps the 4-active cap (no per-slot caps); a 5th active gets a penalty, not a veto
export const ACTIVE_OVERFLOW_PENALTY = 0.5;
export interface Base {
  item: Item;
  stat?: ItemStat;
  pop: number;
  winLift: number;
  kit: number;
  base: number;
  counter: number;
  observedWinRate: number | null;
  kitMedian: number;
  evidence: {
    baseline: 'hero-stats' | 'neutral';
    currentMatches: number;
    historicalPseudoMatches: number;
    source: 'purchase-round' | 'item';
    round?: number;
  };
}

/** Items that can appear on a draft card. */
const draftable = (i: Item) => !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name);

/**
 * Per-item scores independent of the draft state. Popularity and win-lift are normalised WITHIN TIER:
 * a tier-4 item is picked less often than a tier-1 item mostly because it is offered less often (tier
 * pools are fixed per round), so cross-tier usage says little about quality. Kit value is the raw
 * soul-equivalent stat value (no cost division: everything is free) relative to the tier median, clipped at
 * 2x. The per-tier bonus (BRAWL_WEIGHTS.tier) is what compares a rare (tier-bumped) card with the normal cards of
 * its set: the within-tier terms only say how good a card is among its own tier.
 */
export function baseScores(input: BrawlInput, enemies: number[] = [], round?: number): Map<number, Base> {
  const { hero, abilities, items, analytics } = input;
  const catalog = new Map(items.filter(draftable).map((i) => [i.id, i]));
  const kit = kitProfile(hero, abilities);
  const stats = new Map(
    analytics.item_stats.filter((s) => catalog.has(s.item_id) && validCounts(s)).map((s) => [s.item_id, s]),
  );
  const roundStats = new Map(
    round && roundStatsAvailable(analytics)
      ? analytics.round_item_stats?.filter((s) => s.round === round && validCounts(s)).map((s) => [s.item_id, s])
      : [],
  );
  const tierMax: Record<number, number> = {};
  for (const s of stats.values()) {
    const t = catalog.get(s.item_id)!.item_tier;
    tierMax[t] = Math.max(tierMax[t] ?? 0, s.matches);
  }
  const roundTierMax: Record<number, number> = {};
  for (const row of roundStats.values()) {
    const item = catalog.get(row.item_id);
    if (item) roundTierMax[item.item_tier] = Math.max(roundTierMax[item.item_tier] ?? 0, row.matches);
  }
  const meanWR = heroBaseline(analytics);

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
  const kitVal = (it: Item) =>
    statContributions(it, kit).some((row) => row.value !== 0) ? rawKit.get(it.id)! : (tierMedian[it.item_tier] ?? 0);
  const kitNorm = (it: Item) => {
    const med = tierMedian[it.item_tier];
    return med ? Math.max(-2, Math.min(2, kitVal(it) / med)) / 2 : kitVal(it) < 0 ? -0.5 : 0.5;
  };

  const out = new Map<number, Base>();
  for (const it of catalog.values()) {
    const stat = stats.get(it.id);
    const roundStat = roundStats.get(it.id);
    const tm = tierMax[it.item_tier] ?? 0;
    const pop =
      stat && tm
        ? stat.matches / tm
        : roundStat && roundTierMax[it.item_tier]
          ? roundStat.matches / roundTierMax[it.item_tier]
          : 0;
    const K = Math.max(200, WIN_SHRINK_FRAC * tm);
    const row = roundStat ?? stat;
    // All-match history is not a purchase-round prior: the populations have different semantics.
    const prior = row && !roundStat ? historicalPrior(analytics, it.id, row.matches) : { matches: 0, rate: 0.5 };
    const winLift = row ? (smoothedRate(row, meanWR, K, prior) - meanWR) * 10 * pop : 0;
    // counter: how much better the item does against the known enemies than against the field
    let counter = 0,
      n = 0;
    if (stat)
      for (const e of enemies) {
        const rows = analytics.vs[String(e)];
        if (!rows) continue;
        const r = rows.find((x) => x.item_id === it.id);
        if (!validCounts(r) || r.matches < MIN_VS_MATCHES) continue;
        // No exact enemy-filtered hero denominator is available; compare associations around the
        // same exact field baseline, without summing overlapping item rows into hero-games.
        const liftVs = smoothedRate(r, meanWR, K) - meanWR;
        const liftAll = smoothedRate(stat, meanWR, K, historicalPrior(analytics, it.id, stat.matches)) - meanWR;
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
    out.set(it.id, {
      item: it,
      stat,
      pop,
      winLift,
      kit: k,
      base,
      counter,
      observedWinRate: row ? row.wins / row.matches : null,
      kitMedian: tierMedian[it.item_tier] ?? 0,
      evidence: {
        baseline: validCounts(analytics.hero_stats) ? 'hero-stats' : 'neutral',
        currentMatches: row?.matches ?? 0,
        historicalPseudoMatches: prior.matches,
        source: roundStat ? 'purchase-round' : 'item',
        round: roundStat ? round : undefined,
      },
    });
  }
  return out;
}

/** Residual pair association (×10), above both individual smoothed associations. Not causal synergy. */
export function pairLifts(input: BrawlInput): Map<string, number> {
  const baseline = heroBaseline(input.analytics);
  const stats = new Map(input.analytics.item_stats.filter(validCounts).map((row) => [row.item_id, row]));
  const strength = Math.max(200, WIN_SHRINK_FRAC * Math.max(0, ...[...stats.values()].map((row) => row.matches)));
  const pair = new Map<string, number>();
  for (const p of input.analytics.permutation_stats) {
    if (p.item_ids.length !== 2 || !validCounts(p)) continue;
    const [a, b] = p.item_ids;
    const sa = stats.get(a),
      sb = stats.get(b);
    if (a === b || !sa || !sb) continue; // missing individual evidence cannot establish interaction
    const rate = (row: ItemStat) =>
      smoothedRate(row, baseline, strength, historicalPrior(input.analytics, row.item_id, row.matches));
    const expected = Math.max(0, Math.min(1, rate(sa) + rate(sb) - baseline));
    const lift = (smoothedRate(p, expected, strength) - expected) * 10;
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
  const kit = kitProfile(input.hero, input.abilities);
  const enhancedOverride = input.enhancedScoring?.itemOverrides?.[item.id];
  const enhancedProperties = enhanced ? enhancedOverride?.properties : undefined;
  const evaluatedItem = enhancedProperties ? { ...item, properties: enhancedProperties } : item;
  const mult = buildStatMultipliers(evaluatedItem, ownedItems, kit);
  const rows = statContributions(evaluatedItem, mult);
  const raw = statValue(evaluatedItem, mult);
  const marginalKit =
    b && rows.some((row) => row.value !== 0)
      ? b.kitMedian
        ? Math.max(-2, Math.min(2, raw / b.kitMedian)) / 2
        : raw < 0
          ? -0.5
          : b.kit
      : (b?.kit ?? 0);
  const enhancedMult =
    enhanced && !enhancedProperties
      ? (enhancedOverride?.statMultiplier ?? input.enhancedScoring?.statMultiplier ?? ENHANCED_STAT_MULT)
      : 1;
  const enhancedBonus = enhanced
    ? (enhancedOverride?.scoreBonus ?? input.enhancedScoring?.scoreBonus ?? BRAWL_WEIGHTS.enhanced)
    : 0;
  const overlap = counterMarginal(item, ownedItems);
  const parts: ScoreParts = {
    pop: b ? BRAWL_WEIGHTS.popularity * Math.sqrt(b.pop) : 0,
    winLift: b ? BRAWL_WEIGHTS.winLift * b.winLift : 0,
    kit: BRAWL_WEIGHTS.kit * marginalKit * enhancedMult,
    tier: BRAWL_WEIGHTS.tier * (item.item_tier - 1),
    counter: b ? BRAWL_WEIGHTS.counter * b.counter * overlap : 0,
    synergy: BRAWL_WEIGHTS.synergy * synergy,
    active: (item.is_active_item ? BRAWL_WEIGHTS.active : 0) + activePenalty,
    upgrade: upgradesOwned ? BRAWL_WEIGHTS.upgrade : 0,
    enhanced: enhancedBonus,
    dup: dup ? -BRAWL_WEIGHTS.dup : 0,
  };
  const score = Object.values(parts).reduce((a, x) => a + x, 0);
  const why: string[] = [];
  const hero = input.hero.name;
  if (!b?.evidence.currentMatches) why.push('no Street Brawl data for this item yet');
  if (b?.evidence.baseline === 'neutral') why.push('hero-game baseline missing; neutral 50% prior');
  if (b?.evidence.historicalPseudoMatches)
    why.push(
      `historical prior: ${b.evidence.historicalPseudoMatches.toFixed(0)} pseudo-observations, current patch weighted more strongly`,
    );
  if (b?.evidence.source === 'purchase-round')
    why.push(`round ${b.evidence.round} purchase association with match wins; not round victories or a causal effect`);
  if (b && b.pop > 0.5)
    why.push(`${(b.pop * 100).toFixed(0)}% relative usage vs the top tier-${item.item_tier} pick for ${hero}`);
  if (b && Math.abs(b.winLift) > 0.1)
    why.push(
      `${b.winLift > 0 ? 'positive' : 'negative'} match-win association vs ${hero} baseline; weighted statistical score ${b.winLift.toFixed(2)}`,
    );
  if (b && b.kit > 0.7) why.push(`scales ${hero}'s kit`);
  if (b && b.counter > 0.1) why.push('positive enemy-conditioned match-win association');
  if (b && b.counter < -0.1) why.push('negative enemy-conditioned match-win association');
  if (overlap < 1) why.push('diminished counter value: a held item already supplies the same effect');
  if (synergy > 0.2) why.push('positive pair interaction beyond individual item associations');
  if (synergy < -0.2) why.push('negative pair interaction beyond individual item associations');
  if (rows.some((row) => row.applicability === 'conditional'))
    why.push('conditional stat effects have unknown uptime; positive values excluded from permanent kit value');
  if (Object.keys(mult).some((key) => mult[key] < (kit[key] ?? 1)))
    why.push('diminishing marginal stats: your build already supplies this benefit');
  if (upgradesOwned)
    why.push(
      `upgrades ${ownedItems.find((o) => item.component_items.includes(o.class_name))!.name}, which you already hold`,
    );
  if (activePenalty) why.push(`you already hold ${actives} active items`);
  if (enhanced)
    why.push(
      enhancedProperties
        ? 'enhanced properties supplied by local override'
        : `enhanced fallback assumption: stat ×${enhancedMult}, bonus ${enhancedBonus}`,
    );
  if (dup) why.push('you already hold this item');
  return {
    item,
    enhanced,
    score,
    parts,
    why,
    usage: b?.pop ?? 0,
    winRate: b?.observedWinRate ?? null,
    known: !!b?.evidence.currentMatches,
  };
}

/** Ranks every card, chooses the jointly best pick per set, and says whether a reroll is worth it. */
export function adviseDraft(input: BrawlInput, state: DraftState): DraftAdvice {
  const bases = baseScores(input, state.enemies, state.round);
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

  // A live unread counter is explicitly null and never authorises spending. Undefined retains the
  // documented legacy CLI default; callers that capture the game always pass the observed count.
  const rerollsRemaining =
    state.rerollsRemaining === undefined
      ? (input.config.item_draft_rerolls_per_round[
          Math.min(state.round, input.config.item_draft_rerolls_per_round.length) - 1
        ] ?? 0)
      : state.rerollsRemaining;
  const choiceIndex = state.choice === undefined ? state.sets.findIndex((set) => set.length > 0) : state.choice - 1;
  const evaluation = evaluateReroll({
    choices: layout.map((tier, i) => ({ normalTier: tier.normal, rareTier: tier.rare, offers: state.sets[i] })),
    choiceIndex,
    rerollsRemaining,
    itemTier: (id) => bases.get(id)?.item.item_tier,
    scoreOffer: (offer) => scoreOffer(input, bases, pair, state, offer).score,
    distribution:
      input.dropDistribution ??
      createUniformDropDistribution([...bases.values()].map(({ item }) => ({ itemId: item.id, tier: item.item_tier }))),
  });
  const reroll: RerollAdvice | null = evaluation?.shouldReroll
    ? {
        set: choiceIndex,
        currentBest: evaluation.currentBest,
        expectedBest: evaluation.expectedBest,
        gain: evaluation.gain,
        holdValue: evaluation.holdValue,
        pool: evaluation.pool,
        distributionStatus: evaluation.distributionStatus,
        assumptions: evaluation.assumptions,
        decisionAdvantage: evaluation.decisionAdvantage,
      }
    : null;
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
