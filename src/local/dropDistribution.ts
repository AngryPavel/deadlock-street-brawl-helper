/**
 * Drop probabilities are separate from item quality. Pick popularity is not a drop rate.
 * Neither equal item probabilities nor independent draws are established by the assets API.
 */
export interface PoolItem {
  itemId: number;
  tier: number;
}

export interface WeightedItem {
  itemId: number;
  weight: number;
}

export interface SlotFlags {
  rare: boolean;
  enhanced: boolean;
}

export interface FlagScenario {
  flags: readonly SlotFlags[];
  weight: number;
}

export interface DropDistribution {
  status: 'approximation' | 'empirical-approximation';
  source: string;
  assumptions: readonly string[];
  /** Positive weights need not sum to one. No eligible items means an unsupported tier. */
  pool: (tier: number) => readonly WeightedItem[];
  /** Joint flags for an initial draw. Rerolls must keep a selected scenario unchanged. */
  flagScenarios: (choiceIndex: number, slotCount: number) => readonly FlagScenario[];
}

const ITEM_ASSUMPTIONS = [
  'Items are drawn independently with replacement within each tier; game sampling is unverified.',
  'The published normal/good bucket weights are unused because item memberships are unavailable.',
] as const;

export interface UniformDropOptions {
  /** Assumptions supplied by the caller, never estimates from recognition fixtures. */
  pRare?: number;
  pEnhanced?: number;
}

function probability(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Drop probability must be in [0, 1]');
  return value;
}

/** Enumerate flags before evaluating decisions: mixing score distributions first loses flag persistence. */
export function independentFlagScenarios(slotCount: number, pRare = 0, pEnhanced = 0): FlagScenario[] {
  probability(pRare);
  probability(pEnhanced);
  if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 3)
    throw new Error('A draft must contain between one and three slots');
  let scenarios: FlagScenario[] = [{ flags: [], weight: 1 }];
  for (let slot = 0; slot < slotCount; slot++) {
    const next: FlagScenario[] = [];
    for (const scenario of scenarios)
      for (const rare of [false, true])
        for (const enhanced of [false, true]) {
          const weight = scenario.weight * (rare ? pRare : 1 - pRare) * (enhanced ? pEnhanced : 1 - pEnhanced);
          if (weight > 0) next.push({ flags: [...scenario.flags, { rare, enhanced }], weight });
        }
    scenarios = next;
  }
  return scenarios;
}

/**
 * Explicit fallback: equal weights, no assumed bonus flags on unseen sets. Zero bonus probability is
 * a low-bonus scenario, not a calibrated rate or a guarantee that every reroll decision is conservative.
 * The config outcome-count tables have unverified semantics and are deliberately not interpreted here.
 */
export function createUniformDropDistribution(
  items: readonly PoolItem[],
  options: UniformDropOptions = {},
): DropDistribution {
  const pRare = probability(options.pRare);
  const pEnhanced = probability(options.pEnhanced);
  const pools = new Map<number, WeightedItem[]>();
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    const pool = pools.get(item.tier) ?? [];
    pool.push({ itemId: item.itemId, weight: 1 });
    pools.set(item.tier, pool);
  }
  const flags = new Map<number, FlagScenario[]>();
  return {
    status: 'approximation',
    source: 'Uniform tier pools; uncalibrated future slot flags',
    assumptions: [
      ...ITEM_ASSUMPTIONS,
      'Every eligible item in a tier has equal probability; chosen-item analytics do not determine these weights.',
      `Future flags are independent assumptions: rare=${pRare}, enhanced=${pEnhanced}.`,
    ],
    pool: (tier) => pools.get(tier) ?? [],
    flagScenarios: (_choiceIndex, slotCount) => {
      let result = flags.get(slotCount);
      if (!result) {
        result = independentFlagScenarios(slotCount, pRare, pEnhanced);
        flags.set(slotCount, result);
      }
      return result;
    },
  };
}

export interface OfferObservation {
  /** One accepted offer generation, not one screenshot/frame and not one selected item. */
  eventId: string;
  source: 'offered-cards';
  patch: string;
  heroId: number;
  round: number;
  choice: number; // 1-based
  generation: 'initial' | 'reroll';
  observedAt: string;
  cards: readonly (PoolItem & SlotFlags)[]; // complete, unchosen three-card offer
}

export interface ObservationContext {
  patch: string;
  heroId: number;
  round: number;
}

/** Validate at the journal boundary so chosen-item rows and repeated accepted frames cannot be samples. */
export function isOfferObservation(value: unknown): value is OfferObservation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<OfferObservation>;
  return (
    row.source === 'offered-cards' &&
    typeof row.eventId === 'string' &&
    row.eventId.length > 0 &&
    typeof row.patch === 'string' &&
    row.patch.length > 0 &&
    Number.isInteger(row.heroId) &&
    Number.isInteger(row.round) &&
    (row.round ?? 0) >= 1 &&
    Number.isInteger(row.choice) &&
    (row.choice ?? 0) >= 1 &&
    (row.choice ?? 0) <= 3 &&
    (row.generation === 'initial' || row.generation === 'reroll') &&
    typeof row.observedAt === 'string' &&
    Number.isFinite(Date.parse(row.observedAt)) &&
    Array.isArray(row.cards) &&
    row.cards.length === 3 &&
    row.cards.every(
      (card) =>
        card &&
        Number.isInteger(card.itemId) &&
        Number.isInteger(card.tier) &&
        card.tier >= 1 &&
        typeof card.rare === 'boolean' &&
        typeof card.enhanced === 'boolean',
    )
  );
}

/** Exact context isolation and generation deduplication for a caller-owned empirical journal. */
export function offeredSamples(rows: readonly unknown[], context: ObservationContext): OfferObservation[] {
  const seen = new Set<string>();
  return rows.filter((row): row is OfferObservation => {
    if (
      !isOfferObservation(row) ||
      row.patch !== context.patch ||
      row.heroId !== context.heroId ||
      row.round !== context.round ||
      seen.has(row.eventId)
    )
      return false;
    seen.add(row.eventId);
    return true;
  });
}

/**
 * Experimental empirical model, explicitly selected by a caller. Counts offered cards, including rerolls,
 * while learning joint flag patterns only from initial generations (a reroll repeats existing flags).
 * Sparse/unseen tiers and choices fall back to the declared uniform approximation. This does not establish
 * independence, remove screen-recognition bias, or justify combining observations across patches/heroes/rounds.
 */
export function createEmpiricalDropDistribution(
  items: readonly PoolItem[],
  rows: readonly unknown[],
  context: ObservationContext,
  fallback = createUniformDropDistribution(items),
): DropDistribution & { sampleCount: number; initialSetCount: number } {
  const samples = offeredSamples(rows, context);
  const eligible = new Map(items.map((item) => [item.itemId, item.tier]));
  const valid = samples.filter((row) => row.cards.every((card) => eligible.get(card.itemId) === card.tier));
  const counts = new Map<number, Map<number, number>>();
  const flags = new Map<number, Map<string, FlagScenario>>();
  let initialSetCount = 0;
  for (const row of valid) {
    for (const card of row.cards) {
      const tier = counts.get(card.tier) ?? new Map<number, number>();
      tier.set(card.itemId, (tier.get(card.itemId) ?? 0) + 1);
      counts.set(card.tier, tier);
    }
    if (row.generation !== 'initial') continue;
    initialSetCount++;
    const patterns = flags.get(row.choice - 1) ?? new Map<string, FlagScenario>();
    const pattern = row.cards.map(({ rare, enhanced }) => ({ rare, enhanced }));
    const key = pattern.map(({ rare, enhanced }) => `${+rare}${+enhanced}`).join(',');
    const old = patterns.get(key);
    patterns.set(key, { flags: pattern, weight: (old?.weight ?? 0) + 1 });
    flags.set(row.choice - 1, patterns);
  }
  return {
    status: 'empirical-approximation',
    source: `Offered-card journal for patch ${context.patch}, hero ${context.heroId}, round ${context.round}`,
    assumptions: [
      ...ITEM_ASSUMPTIONS,
      'Observed item frequencies are pooled within tier; slot/flag/item dependencies and recognition bias remain unverified.',
      'Unobserved contexts use the explicit fallback; sparse empirical frequencies have no precision guarantee.',
    ],
    sampleCount: valid.length,
    initialSetCount,
    pool: (tier) => {
      const observed = counts.get(tier);
      return observed ? [...observed].map(([itemId, weight]) => ({ itemId, weight })) : fallback.pool(tier);
    },
    flagScenarios: (choiceIndex, slotCount) => {
      const observed = flags.get(choiceIndex);
      return observed && slotCount === 3 ? [...observed.values()] : fallback.flagScenarios(choiceIndex, slotCount);
    },
  };
}
