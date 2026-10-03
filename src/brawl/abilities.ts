import type { Ability, AbilityOrderStat, AbilityStep, Hero } from '../types';
import type { BrawlInput } from './types';

const TOP_N = 10; // candidates considered for "prefer the longest sequence" among near-equally-good scores

export interface BrawlAbilityOrder {
  steps: AbilityStep[];
  support: { matches: number; winRate: number } | null;
  alternatives: { steps: AbilityStep[]; matches: number; winRate: number }[];
}

const stepsFor = (seq: number[], byId: Map<number, AbilityStep['ability']>): AbilityStep[] => {
  const seen = new Map<number, number>();
  const steps: AbilityStep[] = [];
  seq.forEach((id, index) => {
    const a = byId.get(id);
    if (!a) return;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 2) return;
    // Every ability starts unlocked in Street Brawl, so an ability's first appearance is its tier-1 point.
    const kind = n === 0 ? 'tier1' : n === 1 ? 'tier2' : 'tier3';
    steps.push({ ability: a, kind, index });
  });
  return steps;
};

/** Suggests a full-game ability level-up order from Street Brawl ability-order-stats, ranked by shrunk win
 *  rate x log(matches) with no minimum length (Street Brawl sequences run 7-12 long), preferring the longest sequence among the top-scoring
 *  ones, so the suggestion covers the whole game instead of stopping early. */
export function brawlAbilityOrder(input: BrawlInput): BrawlAbilityOrder {
  const stats: AbilityOrderStat[] = input.analytics.ability_order_stats ?? [];
  const byId = new Map(input.abilities.map((a) => [a.id, a]));
  const sig = input.abilities.filter((a) => input.hero.abilities.includes(a.class_name));
  const sigIds = new Set(sig.map((a) => a.id));
  const totalW = stats.reduce((a, s) => a + s.wins, 0);
  const totalM = stats.reduce((a, s) => a + s.matches, 0);
  const mean = totalM ? totalW / totalM : 0.5;
  const K = Math.max(50, 0.05 * Math.max(1, ...stats.map((s) => s.matches)));
  const ranked = stats
    .filter((s) => s.abilities.length > 0 && s.abilities.every((id) => sigIds.has(id)))
    .map((s) => ({ s, score: ((s.wins + K * mean) / (s.matches + K)) * Math.log(1 + s.matches) }))
    .sort((a, b) => b.score - a.score || a.s.abilities.join().localeCompare(b.s.abilities.join()));

  if (!ranked.length) {
    const ids = input.hero.abilities
      .map((c) => sig.find((a) => a.class_name === c)?.id)
      .filter((x): x is number => !!x);
    const seq = [...ids];
    for (let t = 0; t < 3; t++) for (const id of ids) seq.push(id);
    return { steps: stepsFor(seq, byId), support: null, alternatives: [] };
  }

  const top = ranked.slice(0, TOP_N);
  const best = [...top].sort((a, b) => b.s.abilities.length - a.s.abilities.length || b.score - a.score)[0];
  const rest = ranked.filter((r) => r !== best).slice(0, 3);

  return {
    steps: stepsFor(best.s.abilities, byId),
    support: { matches: best.s.matches, winRate: best.s.wins / best.s.matches },
    alternatives: rest.map((r) => ({
      steps: stepsFor(r.s.abilities, byId),
      matches: r.s.matches,
      winRate: r.s.wins / r.s.matches,
    })),
  };
}

/** Index of the order step nearest this draft choice, for highlighting the ability-order list. */
export const abilityStepIndex = (round: number, choice: number) => (round - 1) * 3 + choice - 1;

/** Ability points Street Brawl hands out per round (rounds 1-5; deadlock.wiki "Street Brawl", `m_vecAPPerRound`). */
export const AP_PER_ROUND = [6, 6, 5, 5, 10] as const;
/** Cost of the tier 1 / 2 / 3 point pill. Four abilities fully upgraded cost 32, the five rounds' total. */
export const PILL_COST = [1, 2, 5] as const;

/** How a point looks in the ability panel: spent this round (`now`, highlighted), spent in an earlier round
 *  (`done`, dark with a check), or not yet spent (`later`). */
export type PointState = 'now' | 'done' | 'later';

export interface PanelSlot {
  name: string;
  icon: string; // app-relative image path
  key: string;
  /** Point pills top to bottom: cost 5 (tier 3), cost 2 (tier 2), cost 1 (tier 1). */
  tiers: [PointState, PointState, PointState];
}

/** The ability upgrade panel for one round: the hero's four abilities in bar order with each point's state. */
export interface AbilityPanelData {
  round: number;
  /** Ability points this round hands out (6/6/5/5/10). */
  points: number;
  slots: PanelSlot[];
}

/** Key caps under the four abilities, left to right (the third is a guess: the reference shot hides it). */
export const ABILITY_KEYS = ['Q', 'E', 'R', 'F'] as const;

/** Which round (1-5) buys each pill, keyed `<class_name>:<tier 1-3>`. Follows the standard order strictly; a pill
 *  that does not fit waits and the unspent points carry to the next round. If the order ends early, the rest are
 *  bought tier 1s first, then tier 2s, then tier 3s, in bar order, so rounds 1-5 always spend all 32. */
export function pillRounds(order: BrawlAbilityOrder, hero: Hero): Map<string, number> {
  const classes = hero.abilities.slice(0, 4);
  const queue: string[] = [];
  const add = (k: string) => {
    if (!queue.includes(k)) queue.push(k);
  };
  for (const st of order.steps) {
    const tier = st.kind === 'tier2' ? 2 : st.kind === 'tier3' ? 3 : 1;
    if (classes.includes(st.ability.class_name)) add(`${st.ability.class_name}:${tier}`);
  }
  for (const tier of [1, 2, 3]) for (const c of classes) add(`${c}:${tier}`);
  const out = new Map<string, number>();
  let spent = 0;
  let cap = 0;
  AP_PER_ROUND.forEach((pts, r) => {
    cap += pts;
    while (queue.length) {
      const cost = PILL_COST[Number(queue[0]!.split(':')[1]) - 1]!;
      if (spent + cost > cap) break;
      out.set(queue.shift()!, r + 1);
      spent += cost;
    }
  });
  return out;
}

/** The standard order's points as the panel shows them for `round`: pills bought with this round's points are
 *  `now`, those bought earlier `done`, the rest `later`. */
export function abilityPanelFor(
  order: BrawlAbilityOrder,
  hero: Hero,
  abilities: Ability[],
  round: number,
): AbilityPanelData {
  const rounds = pillRounds(order, hero);
  const slots = hero.abilities.slice(0, 4).map((cls, i): PanelSlot => {
    const at = (tier: number): PointState => {
      const r = rounds.get(`${cls}:${tier}`);
      return r === undefined || r > round ? 'later' : r === round ? 'now' : 'done';
    };
    const ability = abilities.find((a) => a.class_name === cls);
    return {
      name: ability?.name ?? cls,
      icon: ability?.image_webp ?? '',
      key: ABILITY_KEYS[i]!,
      tiers: [at(3), at(2), at(1)],
    };
  });
  return { round, points: AP_PER_ROUND[round - 1] ?? 0, slots };
}
