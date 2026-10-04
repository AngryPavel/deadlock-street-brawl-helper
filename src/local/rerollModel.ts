import type { DropDistribution, SlotFlags } from './dropDistribution';

export interface RerollOffer {
  itemId: number;
  enhanced?: boolean;
  rare?: boolean;
}

export interface RerollChoice {
  normalTier: number;
  rareTier: number;
  /** Empty or absent means an unseen future choice. A known choice must have every slot. */
  offers?: readonly RerollOffer[];
  slotCount?: number; // 3 in the game; smaller values support exact small-pool checks
}

export interface RerollModelInput {
  choices: readonly RerollChoice[];
  choiceIndex: number; // current choice, 0-based
  rerollsRemaining: number | null | undefined;
  itemTier: (itemId: number) => number | undefined;
  /** The same full scoring function for observed and fresh offers, with the current context fixed. */
  scoreOffer: (offer: RerollOffer) => number;
  distribution: DropDistribution;
}

export interface RerollEvaluation {
  shouldReroll: boolean;
  currentBest: number;
  /** Value after the first reroll, including optimal reuse of the remaining budget in this choice. */
  expectedBest: number;
  gain: number;
  /** Marginal value of the token in later choices; zero on the final choice. */
  holdValue: number;
  decisionAdvantage: number;
  rerollsRemaining: number;
  pool: { tier: number; rareTier: number; pRare: number };
  distributionStatus: DropDistribution['status'];
  assumptions: readonly string[];
}

interface Mass {
  score: number;
  weight: number;
}

interface ScoreDistribution {
  values: Mass[];
  mean: number;
  /** E[max(X, threshold)], using a CDF/prefix sum rather than enumerating card combinations. */
  above: (threshold: number) => number;
}

const EPSILON = 1e-10;
const MAX_REROLLS = 10;

/** Unread/invalid counts cannot authorise spending. Counts above the supported horizon are capped. */
export function usableRerolls(value: number | null | undefined): number {
  return value != null && Number.isInteger(value) && value > 0 ? Math.min(value, MAX_REROLLS) : 0;
}

function scoreDistribution(masses: readonly Mass[]): ScoreDistribution | null {
  const combined = new Map<number, number>();
  for (const { score, weight } of masses) {
    if (!Number.isFinite(score) || !Number.isFinite(weight) || weight < 0) return null;
    if (weight > 0) combined.set(score, (combined.get(score) ?? 0) + weight);
  }
  const total = [...combined.values()].reduce((a, weight) => a + weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const values = [...combined]
    .map(([score, weight]) => ({ score, weight: weight / total }))
    .sort((a, b) => a.score - b.score);
  const cdf = [0],
    prefix = [0];
  for (const { score, weight } of values) {
    cdf.push(cdf.at(-1)! + weight);
    prefix.push(prefix.at(-1)! + score * weight);
  }
  const mean = prefix.at(-1)!;
  return {
    values,
    mean,
    above: (threshold) => {
      let lo = 0,
        hi = values.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (values[mid].score <= threshold) lo = mid + 1;
        else hi = mid;
      }
      return threshold * cdf[lo] + mean - prefix[lo];
    },
  };
}

/** CDF(max X_i)=product CDF(X_i) under the distribution's explicit independence assumption. */
function maximumDistribution(slots: readonly ScoreDistribution[]): ScoreDistribution | null {
  const values = [...new Set(slots.flatMap((slot) => slot.values.map((mass) => mass.score)))].sort((a, b) => a - b);
  const indexes = slots.map(() => 0),
    cdfs = slots.map(() => 0);
  const masses: Mass[] = [];
  let previous = 0;
  for (const score of values) {
    let cumulative = 1;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i].values;
      while (indexes[i] < slot.length && slot[indexes[i]].score <= score) cdfs[i] += slot[indexes[i]++].weight;
      cumulative *= Math.min(1, cdfs[i]);
    }
    if (cumulative > previous) masses.push({ score, weight: cumulative - previous });
    previous = cumulative;
  }
  return scoreDistribution(masses);
}

/**
 * Finite-horizon optimal stopping, exact under the declared drop and frozen-score approximations.
 * Let C_r be the value of later choices with r tokens and D_f the fresh best-score distribution
 * with fixed slot flags f. Spending a token has value A[f,1]=E[D_f]+C_0 and, for r>1,
 * A[f,r]=E[max(D_f+C_(r-1), A[f,r-1])]. At observed score x, take x+C_r or spend for A[f,r].
 * For an unseen choice, average max(D_f+C_r,A[f,r]) over initial flag scenarios AFTER solving
 * each fixed-flag problem. Future accepted items do not modify the current scoring context.
 *
 * Complexity is polynomial in score supports, flag scenarios, choices and the <=10 token budget;
 * no pool-size^cards or pool-size^rerolls tree is constructed. Pools/scenarios are cached per call.
 * Returns null for unavailable tokens, incomplete observations, or unsupported positive-probability pools.
 */
export function evaluateReroll(input: RerollModelInput): RerollEvaluation | null {
  const budget = usableRerolls(input.rerollsRemaining);
  const current = input.choices[input.choiceIndex];
  if (!budget || !Number.isInteger(input.choiceIndex) || input.choiceIndex < 0 || !current?.offers?.length) return null;
  const scoreCache = new Map<string, number>();
  const score = (offer: RerollOffer): number => {
    const key = `${offer.itemId}:${+!!offer.enhanced}:${+!!offer.rare}`;
    let result = scoreCache.get(key);
    if (result === undefined) {
      result = input.scoreOffer(offer);
      scoreCache.set(key, result);
    }
    return result;
  };
  const cardCache = new Map<string, ScoreDistribution | null>();
  const cardDistribution = (tier: number, enhanced: boolean, rare: boolean): ScoreDistribution | null => {
    const key = `${tier}:${+enhanced}:${+rare}`;
    if (cardCache.has(key)) return cardCache.get(key)!;
    const pool = input.distribution.pool(tier);
    const masses: Mass[] = [];
    for (const item of pool) {
      if (input.itemTier(item.itemId) !== tier) {
        cardCache.set(key, null);
        return null;
      }
      masses.push({ score: score({ itemId: item.itemId, enhanced, rare }), weight: item.weight });
    }
    const result = scoreDistribution(masses);
    cardCache.set(key, result);
    return result;
  };
  const setCache = new Map<string, ScoreDistribution | null>();
  const setDistribution = (choice: RerollChoice, flags: readonly SlotFlags[]): ScoreDistribution | null => {
    // Sort complete flag pairs for caching, never rare and enhanced independently.
    const pairs = flags.map((f) => `${f.rare ? choice.rareTier : choice.normalTier}:${+f.enhanced}:${+f.rare}`).sort();
    const key = pairs.join(',');
    if (setCache.has(key)) return setCache.get(key)!;
    const slots = flags.map((f) => cardDistribution(f.rare ? choice.rareTier : choice.normalTier, f.enhanced, f.rare));
    const result = slots.every((slot) => slot !== null) ? maximumDistribution(slots) : null;
    setCache.set(key, result);
    return result;
  };

  let future = Array<number>(budget + 1).fill(0);
  let evaluation: RerollEvaluation | null = null;
  for (let j = input.choices.length - 1; j >= input.choiceIndex; j--) {
    const choice = input.choices[j];
    const slotCount = choice.slotCount ?? 3;
    if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 3) return null;
    const offers = choice.offers?.length ? choice.offers : null;
    if (offers && offers.length !== slotCount) return null;
    const knownFlags = offers?.map((offer): SlotFlags | null => {
      const tier = input.itemTier(offer.itemId);
      const rare = offer.rare ?? tier !== choice.normalTier;
      if (tier !== (rare ? choice.rareTier : choice.normalTier)) return null;
      return { rare, enhanced: !!offer.enhanced };
    });
    if (knownFlags?.some((f) => f === null)) return null;
    const scenarios = knownFlags
      ? [{ flags: knownFlags as SlotFlags[], weight: 1 }]
      : input.distribution.flagScenarios(j, slotCount);
    const totalWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
    if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return null;
    const currentBest = offers
      ? Math.max(...offers.map((offer, index) => score({ ...offer, rare: knownFlags![index]!.rare })))
      : null;
    if (currentBest !== null && !Number.isFinite(currentBest)) return null;
    const values = Array<number>(budget + 1).fill(0);
    for (const { flags, weight } of scenarios) {
      if (!Number.isFinite(weight) || weight < 0 || flags.length !== slotCount) return null;
      if (weight === 0) continue;
      const dist = setDistribution(choice, flags);
      if (!dist) return null;
      const p = weight / totalWeight;
      values[0] += p * ((currentBest ?? dist.mean) + future[0]);
      let spend = dist.mean + future[0];
      for (let r = 1; r <= budget; r++) {
        if (r > 1) spend = future[r - 1] + dist.above(spend - future[r - 1]);
        const take = (currentBest ?? dist.mean) + future[r];
        values[r] += p * (currentBest === null ? future[r] + dist.above(spend - future[r]) : Math.max(take, spend));
        if (j === input.choiceIndex && r === budget && currentBest !== null) {
          const expectedBest = spend - future[r - 1];
          const gain = expectedBest - currentBest;
          const holdValue = Math.max(0, future[r] - future[r - 1]);
          const decisionAdvantage = gain - holdValue;
          evaluation = {
            shouldReroll: decisionAdvantage > EPSILON,
            currentBest,
            expectedBest,
            gain,
            holdValue,
            decisionAdvantage,
            rerollsRemaining: budget,
            pool: {
              tier: choice.normalTier,
              rareTier: choice.rareTier,
              pRare: flags.filter((f) => f.rare).length / slotCount,
            },
            distributionStatus: input.distribution.status,
            assumptions: [
              ...input.distribution.assumptions,
              'Future picks retain the current owned/enemy scoring context.',
            ],
          };
        }
      }
    }
    future = values;
  }
  return evaluation;
}
