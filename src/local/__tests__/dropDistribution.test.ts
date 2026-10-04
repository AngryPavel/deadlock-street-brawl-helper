import { describe, expect, it } from 'vitest';
import {
  createEmpiricalDropDistribution,
  createUniformDropDistribution,
  independentFlagScenarios,
  isOfferObservation,
  offeredSamples,
  type OfferObservation,
} from '../dropDistribution';

const items = [
  { itemId: 1, tier: 1 },
  { itemId: 2, tier: 1 },
  { itemId: 3, tier: 2 },
];
const context = { patch: 'patch-a', heroId: 1, round: 2 };
const observation = (overrides: Partial<OfferObservation> = {}): OfferObservation => ({
  ...context,
  source: 'offered-cards',
  eventId: 'event-1',
  choice: 1,
  generation: 'initial',
  observedAt: '2026-10-04T00:00:00Z',
  cards: [
    { itemId: 1, tier: 1, rare: false, enhanced: false },
    { itemId: 2, tier: 1, rare: false, enhanced: true },
    { itemId: 3, tier: 2, rare: true, enhanced: false },
  ],
  ...overrides,
});

describe('declared drop assumptions', () => {
  it('defaults to equal tier weights and explicitly uncalibrated plain future flags', () => {
    const model = createUniformDropDistribution([...items, items[0]]);
    expect(model.status).toBe('approximation');
    expect(model.pool(1)).toEqual([
      { itemId: 1, weight: 1 },
      { itemId: 2, weight: 1 },
    ]);
    expect(model.pool(9)).toEqual([]);
    expect(model.flagScenarios(0, 3)).toEqual([
      { weight: 1, flags: Array.from({ length: 3 }, () => ({ rare: false, enhanced: false })) },
    ]);
    expect(model.assumptions.join(' ')).toContain('memberships are unavailable');
  });

  it('enumerates 64 complete flag patterns with correct total and marginals', () => {
    const scenarios = independentFlagScenarios(3, 0.4, 0.3);
    expect(scenarios).toHaveLength(64);
    expect(scenarios.reduce((a, row) => a + row.weight, 0)).toBeCloseTo(1, 12);
    for (let slot = 0; slot < 3; slot++) {
      expect(scenarios.filter((row) => row.flags[slot].rare).reduce((a, row) => a + row.weight, 0)).toBeCloseTo(
        0.4,
        12,
      );
      expect(scenarios.filter((row) => row.flags[slot].enhanced).reduce((a, row) => a + row.weight, 0)).toBeCloseTo(
        0.3,
        12,
      );
    }
    expect(() => independentFlagScenarios(3, -1)).toThrow();
    expect(() => independentFlagScenarios(3, 0, NaN)).toThrow();
  });
});

describe('offered-card empirical journal', () => {
  it('isolates patch, hero and round, excludes chosen-popularity rows and deduplicates accepted frames', () => {
    const rows: unknown[] = [
      observation(),
      observation(),
      observation({ eventId: 'other-patch', patch: 'patch-b' }),
      observation({ eventId: 'other-hero', heroId: 2 }),
      observation({ eventId: 'other-round', round: 3 }),
      { item_id: 1, matches: 100000, wins: 50000 },
      { ...observation({ eventId: 'selected' }), source: 'chosen-item' },
      { ...observation({ eventId: 'partial' }), cards: observation().cards.slice(0, 2) },
    ];
    expect(offeredSamples(rows, context).map((row) => row.eventId)).toEqual(['event-1']);
    expect(isOfferObservation(observation())).toBe(true);
    expect(isOfferObservation({ ...observation(), observedAt: 'invalid' })).toBe(false);
  });

  it('learns item frequencies from all generations but flag probabilities only from initial offers', () => {
    const initial = observation();
    const reroll = observation({
      eventId: 'reroll-1',
      generation: 'reroll',
      cards: initial.cards.map((card) => ({ ...card, itemId: card.tier === 1 ? 1 : 3 })),
    });
    const model = createEmpiricalDropDistribution(items, [initial, reroll, reroll], context);
    expect(model.status).toBe('empirical-approximation');
    expect(model.sampleCount).toBe(2);
    expect(model.initialSetCount).toBe(1);
    expect(model.pool(1)).toEqual([
      { itemId: 1, weight: 3 },
      { itemId: 2, weight: 1 },
    ]);
    expect(model.flagScenarios(0, 3)).toEqual([
      { weight: 1, flags: initial.cards.map(({ rare, enhanced }) => ({ rare, enhanced })) },
    ]);
    expect(model.flagScenarios(1, 3)[0].flags.every((flag) => !flag.rare && !flag.enhanced)).toBe(true);
  });

  it('rejects a generation containing unknown or wrong-tier items', () => {
    const wrong = observation({ cards: observation().cards.map((card) => ({ ...card, tier: 9 })) });
    const model = createEmpiricalDropDistribution(items, [wrong], context);
    expect(model.sampleCount).toBe(0);
    expect(model.pool(1)).toEqual(createUniformDropDistribution(items).pool(1));
  });
});
