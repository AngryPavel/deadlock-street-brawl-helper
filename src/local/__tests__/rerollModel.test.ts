import { describe, expect, it } from 'vitest';
import { createUniformDropDistribution, type DropDistribution, type SlotFlags } from '../dropDistribution';
import { evaluateReroll, usableRerolls, type RerollModelInput, type RerollOffer } from '../rerollModel';
import { baseScores, pairLifts, roundTiers, scoreOffer } from '../../brawl/engine';
import { heroByName, inputFor, itemByName } from '../../brawl/__tests__/testData';

const items = [
  { itemId: 1, tier: 1 },
  { itemId: 2, tier: 1 },
  { itemId: 3, tier: 2 },
  { itemId: 4, tier: 2 },
];
const scores = new Map([
  [1, 0],
  [2, 10],
  [3, 2],
  [4, 14],
]);
const baseInput = (): RerollModelInput => ({
  choices: [{ normalTier: 1, rareTier: 2, slotCount: 1, offers: [{ itemId: 1 }] }],
  choiceIndex: 0,
  rerollsRemaining: 1,
  itemTier: (id) => items.find((item) => item.itemId === id)?.tier,
  scoreOffer: (offer) => scores.get(offer.itemId)! + (offer.enhanced ? 3 : 0),
  distribution: createUniformDropDistribution(items),
});

/** Independent reference: enumerate every card tuple and recurse over both actions, without a maximum CDF. */
function bruteForce(input: RerollModelInput) {
  const cache = new Map<string, number>();
  const draw = (j: number, flags: readonly SlotFlags[], consume: (offers: RerollOffer[]) => number): number => {
    const choice = input.choices[j];
    const visit = (slot: number, offers: RerollOffer[]): number => {
      if (slot === flags.length) return consume(offers);
      const flag = flags[slot];
      const pool = input.distribution.pool(flag.rare ? choice.rareTier : choice.normalTier);
      const total = pool.reduce((a, item) => a + item.weight, 0);
      return pool.reduce(
        (a, item) => a + (item.weight / total) * visit(slot + 1, [...offers, { itemId: item.itemId, ...flag }]),
        0,
      );
    };
    return visit(0, []);
  };
  const before = (j: number, r: number): number => {
    if (j === input.choices.length) return 0;
    const key = `before:${j}:${r}`;
    if (cache.has(key)) return cache.get(key)!;
    const choice = input.choices[j];
    let result: number;
    if (choice.offers?.length) result = observed(j, choice.offers, r);
    else {
      const scenarios = input.distribution.flagScenarios(j, choice.slotCount ?? 3);
      const total = scenarios.reduce((a, scenario) => a + scenario.weight, 0);
      result = scenarios.reduce(
        (a, scenario) => a + (scenario.weight / total) * draw(j, scenario.flags, (offers) => observed(j, offers, r)),
        0,
      );
    }
    cache.set(key, result);
    return result;
  };
  const flagsFor = (j: number, offers: readonly RerollOffer[]) =>
    offers.map((offer) => ({
      rare: offer.rare ?? input.itemTier(offer.itemId) !== input.choices[j].normalTier,
      enhanced: !!offer.enhanced,
    }));
  const observed = (j: number, offers: readonly RerollOffer[], r: number): number => {
    const flags = flagsFor(j, offers);
    const key = `seen:${j}:${r}:${offers.map((offer, i) => `${offer.itemId}:${+flags[i].rare}:${+flags[i].enhanced}`).join(',')}`;
    if (cache.has(key)) return cache.get(key)!;
    const take = Math.max(...offers.map(input.scoreOffer)) + before(j + 1, r);
    const spend = r ? draw(j, flags, (fresh) => observed(j, fresh, r - 1)) : -Infinity;
    const result = Math.max(take, spend);
    cache.set(key, result);
    return result;
  };
  const j = input.choiceIndex,
    r = input.rerollsRemaining!;
  const offers = input.choices[j].offers!;
  const currentBest = Math.max(...offers.map(input.scoreOffer));
  const take = currentBest + before(j + 1, r);
  const spend = draw(j, flagsFor(j, offers), (fresh) => observed(j, fresh, r - 1));
  return {
    advantage: spend - take,
    hold: before(j + 1, r) - before(j + 1, r - 1),
    expectedBest: spend - before(j + 1, r - 1),
  };
}

describe('reroll optimal stopping', () => {
  it.each([null, undefined, 0, -1, NaN, Infinity, 1.5])(
    'never spends unavailable or invalid tokens (%s)',
    (rerollsRemaining) => {
      expect(evaluateReroll({ ...baseInput(), rerollsRemaining })).toBeNull();
    },
  );

  it('uses the remaining count and allows another reroll after a poor first draw', () => {
    const input = baseInput();
    input.scoreOffer = (offer) => (offer.itemId === 99 ? 6 : scores.get(offer.itemId)!);
    input.itemTier = (id) => (id === 99 ? 1 : items.find((item) => item.itemId === id)?.tier);
    input.choices[0].offers = [{ itemId: 99 }];
    const one = evaluateReroll(input)!;
    const two = evaluateReroll({ ...input, rerollsRemaining: 2 })!;
    expect(one.expectedBest).toBe(5);
    expect(one.shouldReroll).toBe(false);
    expect(two.expectedBest).toBe(7.5);
    expect(two.shouldReroll).toBe(true);
    expect(two.holdValue).toBe(0);
    expect(usableRerolls(100)).toBe(10);
  });

  it('has zero reroll value with one item per tier, even when unknown future flags vary', () => {
    const pool = items.filter((item) => item.itemId === 1 || item.itemId === 3);
    const input: RerollModelInput = {
      ...baseInput(),
      distribution: createUniformDropDistribution(pool, { pRare: 0.5, pEnhanced: 0.5 }),
      choices: [
        {
          normalTier: 1,
          rareTier: 2,
          offers: [{ itemId: 1 }, { itemId: 3, enhanced: true }, { itemId: 1, enhanced: true }],
        },
        { normalTier: 1, rareTier: 2 },
        { normalTier: 1, rareTier: 2 },
      ],
      rerollsRemaining: 10,
    };
    const result = evaluateReroll(input)!;
    expect(result.gain).toBeCloseTo(0, 10);
    expect(result.holdValue).toBeCloseTo(0, 10);
    expect(result.shouldReroll).toBe(false);
  });

  it('evaluates current items and fresh items with the same owned-item penalty', () => {
    const input = baseInput();
    input.choices[0].offers = [{ itemId: 1 }];
    input.scoreOffer = ({ itemId }) => (itemId === 1 ? 4 : 10 - 10); // item 2 is already owned
    const result = evaluateReroll(input)!;
    expect(result.currentBest).toBe(4);
    expect(result.expectedBest).toBe(2);
    expect(result.shouldReroll).toBe(false);
  });

  it('uses explicit rare flags when normal and rare tiers coincide', () => {
    const input = baseInput();
    input.choices = [{ normalTier: 1, rareTier: 1, slotCount: 1, offers: [{ itemId: 1, rare: true }] }];
    input.scoreOffer = ({ itemId, rare }) => scores.get(itemId)! + (rare ? 8 : 0);
    const result = evaluateReroll(input)!;
    expect(result.currentBest).toBe(8);
    expect(result.expectedBest).toBe(13);
    expect(result.pool.pRare).toBe(1);
  });

  it('does not invent missing observed slots or silently renormalise an unavailable rare pool', () => {
    const input = baseInput();
    input.choices[0].slotCount = 3;
    expect(evaluateReroll(input)).toBeNull();
    input.choices[0].slotCount = 1;
    input.choices = [...input.choices, { normalTier: 1, rareTier: 99, slotCount: 1 }];
    input.distribution = createUniformDropDistribution(items, { pRare: 0.5 });
    expect(evaluateReroll(input)).toBeNull();
  });

  it('ignores choices already passed', () => {
    const input = baseInput();
    input.choices = [{ normalTier: 999, rareTier: 999 }, ...input.choices];
    input.choiceIndex = 1;
    const result = evaluateReroll(input)!;
    expect(result.expectedBest).toBe(5);
    expect(result.holdValue).toBe(0);
  });

  it.each([1, 2, 3])(
    'matches exhaustive action trees with %i tokens and unknown persistent flags',
    (rerollsRemaining) => {
      const input: RerollModelInput = {
        ...baseInput(),
        rerollsRemaining,
        distribution: createUniformDropDistribution(items, { pRare: 0.4, pEnhanced: 0.3 }),
        choices: [
          { normalTier: 1, rareTier: 2, slotCount: 2, offers: [{ itemId: 1, enhanced: true }, { itemId: 3 }] },
          { normalTier: 1, rareTier: 2, slotCount: 2 },
          { normalTier: 1, rareTier: 2, slotCount: 1 },
        ],
      };
      const expected = bruteForce(input),
        actual = evaluateReroll(input)!;
      expect(actual.decisionAdvantage).toBeCloseTo(expected.advantage, 10);
      expect(actual.expectedBest).toBeCloseTo(expected.expectedBest, 10);
      expect(actual.holdValue).toBeCloseTo(expected.hold, 10);
    },
  );

  it.each([1, 2, 3])('matches exhaustive action trees with known future sets and %i tokens', (rerollsRemaining) => {
    const input = baseInput();
    input.rerollsRemaining = rerollsRemaining;
    input.choices = [
      ...input.choices,
      { normalTier: 1, rareTier: 2, slotCount: 2, offers: [{ itemId: 1 }, { itemId: 3, enhanced: true }] },
    ];
    const expected = bruteForce(input),
      actual = evaluateReroll(input)!;
    expect(actual.decisionAdvantage).toBeCloseTo(expected.advantage, 10);
    expect(actual.holdValue).toBeCloseTo(expected.hold, 10);
  });

  it('handles weighted item draws and correlated initial flags', () => {
    const fallback = createUniformDropDistribution(items);
    const distribution: DropDistribution = {
      ...fallback,
      pool: (tier) => fallback.pool(tier).map((item, i) => ({ ...item, weight: i + 1 })),
      flagScenarios: () => [
        {
          weight: 1,
          flags: [
            { rare: false, enhanced: false },
            { rare: false, enhanced: false },
          ],
        },
        {
          weight: 2,
          flags: [
            { rare: true, enhanced: true },
            { rare: true, enhanced: true },
          ],
        },
      ],
    };
    const input = baseInput();
    input.distribution = distribution;
    input.rerollsRemaining = 2;
    input.choices = [...input.choices, { normalTier: 1, rareTier: 2, slotCount: 2 }];
    expect(evaluateReroll(input)!.decisionAdvantage).toBeCloseTo(bruteForce(input).advantage, 10);
  });

  it('keeps all six Infernus round-2 choice-3 card permutations identical', () => {
    const input = inputFor(heroByName('Infernus').id);
    const bases = baseScores(input),
      pair = pairLifts(input);
    const state = { round: 2, owned: [], enemies: [], sets: [] };
    const cards = ['Capacitor', 'Spirit Rend', 'Cultist Sacrifice'].map((name) => ({
      itemId: itemByName(name).id,
      enhanced: name === 'Spirit Rend',
    }));
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const layout = roundTiers(input, 2);
    const results = permutations.map((order) =>
      evaluateReroll({
        choices: layout.map((tier, i) => ({
          normalTier: tier.normal,
          rareTier: tier.rare,
          offers: i === 2 ? order.map((k) => cards[k]) : [],
        })),
        choiceIndex: 2,
        rerollsRemaining: 2,
        scoreOffer: (offer) => scoreOffer(input, bases, pair, state, offer).score,
        itemTier: (id) => bases.get(id)?.item.item_tier,
        distribution: createUniformDropDistribution(
          [...bases.values()].map(({ item }) => ({ itemId: item.id, tier: item.item_tier })),
        ),
      }),
    );
    expect(results[0]).not.toBeNull();
    for (const result of results.slice(1)) {
      expect(result!.expectedBest).toBeCloseTo(results[0]!.expectedBest, 12);
      expect(result!.gain).toBeCloseTo(results[0]!.gain, 12);
      expect(result!.shouldReroll).toBe(results[0]!.shouldReroll);
    }
  });

  it('scores each item/flag context once with 40 items per tier, 64 flag combinations and 10 tokens', () => {
    const pool = Array.from({ length: 80 }, (_, i) => ({ itemId: i + 1, tier: i < 40 ? 1 : 2 }));
    let evaluations = 0;
    const result = evaluateReroll({
      choices: [
        { normalTier: 1, rareTier: 2, offers: [{ itemId: 1 }, { itemId: 2 }, { itemId: 3, enhanced: true }] },
        { normalTier: 1, rareTier: 2 },
        { normalTier: 1, rareTier: 2 },
      ],
      choiceIndex: 0,
      rerollsRemaining: 10,
      itemTier: (id) => pool[id - 1]?.tier,
      scoreOffer: ({ itemId, enhanced }) => {
        evaluations++;
        return (itemId % 40) / 20 + (enhanced ? 0.6 : 0);
      },
      distribution: createUniformDropDistribution(pool, { pRare: 0.4, pEnhanced: 0.3 }),
    });
    expect(result).not.toBeNull();
    expect(evaluations).toBe(160);
    expect(Number.isFinite(result!.decisionAdvantage)).toBe(true);
  });
});
