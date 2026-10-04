import { describe, expect, it } from 'vitest';
import { baseScores, pairLifts, scoreOffer } from '../../brawl/engine';
import { buildStatMultipliers, counterMarginal, statContributions, statValue } from '../../brawl/kit';
import type { BrawlInput } from '../../brawl/types';
import { heroByName, inputFor, itemByName } from '../../brawl/__tests__/testData';
import type { Item, ItemStat } from '../../types';
import type { StatsWindow } from '../../data/updateTypes';
import { historicalPrior } from '../scoringEvidence';

const template = inputFor(heroByName('Infernus').id);
const item = (id: number, properties: Item['properties'] = { BonusHealth: { value: 100 } }): Item => ({
  ...itemByName('Extra Health'),
  id,
  class_name: `test_${id}`,
  name: `test ${id}`,
  item_tier: 1,
  is_active_item: false,
  component_items: [],
  properties,
  tooltip_sections: [],
});
const stat = (id: number, wins: number, matches: number): ItemStat => ({
  item_id: id,
  wins,
  matches,
  losses: matches - wins,
  players: matches,
  avg_buy_time_s: 0,
  avg_sell_time_s: 0,
  avg_buy_time_relative: 0,
  avg_sell_time_relative: 0,
});
const input = (rows = [stat(1, 500, 1000), stat(2, 500, 1000)]): BrawlInput => ({
  ...template,
  hero: { ...template.hero, id: 999, abilities: [], standard_level_up_upgrades: {} },
  abilities: [],
  items: [item(1), item(2)],
  analytics: {
    hero_id: 999,
    game_mode: 'street_brawl',
    hero_stats: { wins: 500, matches: 1000 },
    item_stats: rows,
    permutation_stats: [],
    vs: {},
  },
});
const window = (role: StatsWindow['role'], min: number, max: number): StatsWindow => ({
  schema_version: 2,
  role,
  patch_id: null,
  min_unix_timestamp: min,
  max_unix_timestamp: max,
  fetched_at: '2026-01-01',
  catalog_fetched_at: '2026-01-01',
  catalog_compatibility: role === 'primary' ? 'current' : 'unverified',
});

describe('patch evidence consumption', () => {
  it('uses exact hero games, independent of repeated item observations', () => {
    const fixture = input([stat(1, 800, 1000), stat(2, 0, 100000)]);
    fixture.analytics.hero_stats = { wins: 800, matches: 1000 };
    expect(baseScores(fixture).get(1)!.winLift).toBeCloseTo(0);
    fixture.analytics.item_stats[1] = stat(2, 100000, 100000);
    expect(baseScores(fixture).get(1)!.winLift).toBeCloseTo(0);
  });

  it('uses a disclosed neutral prior when hero evidence is missing and rejects invalid counts', () => {
    const fixture = input([stat(1, 900, 1000), stat(2, 1001, 1000)]);
    delete fixture.analytics.hero_stats;
    const bases = baseScores(fixture);
    expect(bases.get(1)!.winLift).toBeGreaterThan(0);
    expect(bases.get(1)!.evidence.baseline).toBe('neutral');
    expect(bases.get(2)!.evidence.currentMatches).toBe(0);
    expect(bases.get(2)!.winLift).toBe(0);
  });

  it('caps disjoint historical evidence at 50 and half current evidence, and ignores overlapping windows', () => {
    const fixture = input();
    fixture.analytics.stats_window = window('primary', 100, 200);
    fixture.analytics.historical_stats_window = window('historical-prior', 1, 99);
    fixture.analytics.historical_item_stats = [{ item_id: 1, wins: 100000, matches: 100000 }];
    expect(historicalPrior(fixture.analytics, 1, 1000).matches).toBe(50);
    expect(historicalPrior(fixture.analytics, 1, 20).matches).toBe(10);
    expect(historicalPrior(fixture.analytics, 1, 0).matches).toBe(0);
    expect(baseScores(fixture).get(1)!.evidence.historicalPseudoMatches).toBe(50);
    fixture.analytics.historical_stats_window.max_unix_timestamp = 100;
    expect(historicalPrior(fixture.analytics, 1, 1000).matches).toBe(0);
  });

  it('uses purchase-round match outcomes only with their explicit provenance and explains the limitation', () => {
    const fixture = input();
    fixture.analytics.round_item_stats = [{ item_id: 1, round: 2, wins: 100, matches: 100 }];
    expect(baseScores(fixture, [], 2).get(1)!.winLift).toBe(0);
    fixture.analytics.round_item_stats_provenance = {
      endpoint: '/v1/analytics/item-flow-stats',
      phase_count: 5,
      round_semantics: 'purchase_round',
      outcome_semantics: 'match_win',
      count_semantics: 'purchase',
      reached_per_round: [100, 100, 100, 100, 100],
    };
    const bases = baseScores(fixture, [], 2);
    expect(bases.get(1)!.winLift).toBeGreaterThan(0);
    expect(baseScores(fixture, [], 1).get(1)!.winLift).toBe(0);
    const ranked = scoreOffer(
      fixture,
      bases,
      pairLifts(fixture),
      { round: 2, owned: [], enemies: [], sets: [] },
      { itemId: 1 },
    );
    expect(ranked.why.join(' ')).toContain('not round victories or a causal effect');
    expect(ranked.winRate).toBe(1);
    fixture.analytics.item_stats = [];
    const roundOnly = scoreOffer(
      fixture,
      baseScores(fixture, [], 2),
      new Map(),
      { round: 2, owned: [], enemies: [], sets: [] },
      { itemId: 1 },
    );
    expect(roundOnly.known).toBe(true);
    expect(roundOnly.parts.winLift).toBeGreaterThan(0);
  });
});

describe('pair residual evidence', () => {
  it('does not call two independently strong items synergy', () => {
    const fixture = input([stat(1, 13000, 20000), stat(2, 13000, 20000)]);
    // Smoothed individual rate = 9/14. Independent additive expectation = 11/14.
    fixture.analytics.permutation_stats = [{ item_ids: [1, 2], wins: 11000, losses: 3000, matches: 14000 }];
    expect(pairLifts(fixture).get('1:2')).toBeCloseTo(0, 10);
    fixture.analytics.permutation_stats[0].wins = 12600;
    expect(pairLifts(fixture).get('1:2')).toBeGreaterThan(0);
  });

  it('shrinks tiny samples toward zero and treats missing observations as unknown', () => {
    const fixture = input();
    fixture.analytics.permutation_stats = [{ item_ids: [1, 2], wins: 1, losses: 0, matches: 1 }];
    const small = pairLifts(fixture).get('1:2')!;
    fixture.analytics.permutation_stats[0] = { item_ids: [1, 2], wins: 1000, losses: 0, matches: 1000 };
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(pairLifts(fixture).get('1:2')! / 100);
    fixture.analytics.item_stats.pop();
    expect(pairLifts(fixture).has('1:2')).toBe(false);
  });
});

describe('signed and marginal stat semantics', () => {
  it('retains Trophy Collector NPC penalty, and values negative enemy resistance deltas beneficially', () => {
    const trophy = itemByName('Trophy Collector');
    const noPenalty = { ...trophy, properties: { ...trophy.properties, NonPlayerBonusWeaponPower: { value: 0 } } };
    expect(statValue(noPenalty, {}) - statValue(trophy, {})).toBe(180);
    expect(statValue(item(1, { MagicResistReduction: { value: -10 } }), {})).toBe(450);
    expect(statValue(item(1, { BulletResist: { value: -10 } }), {})).toBe(-550);
  });

  it('records conditional effects and does not price an unknown proc as a permanent stat', () => {
    const conditional = {
      ...item(1, { TechPower: { value: 10 } }),
      tooltip_sections: [
        {
          section_type: 'passive',
          section_attributes: [{ properties: ['TechPower'], loc_string: 'On hit gain Spirit Power' }],
        },
      ],
    };
    expect(statValue(conditional, {})).toBe(0);
    expect(statContributions(conditional, {})[0]).toMatchObject({
      applicability: 'conditional',
      condition: 'On hit gain Spirit Power',
      value: 600,
    });
  });

  it('reduces overlapping percentage stats and counter functions while preserving linear health value', () => {
    const resist = item(1, { BulletResist: { value: 20 }, BonusHealth: { value: 100 } });
    const multipliers = buildStatMultipliers(resist, [resist], {});
    expect(multipliers.BulletResist).toBe(0.5);
    expect(statValue(resist, multipliers)).toBe(1150);
    const healbane = item(2, { HealAmpReceivePenaltyPercent: { value: -40 } });
    expect(counterMarginal(healbane, [healbane])).toBe(0.5);
    expect(counterMarginal(healbane, [resist])).toBe(1);
  });

  it('discloses enhanced fallback and permits exact local property and bonus overrides', () => {
    const fixture = input();
    const state = { round: 1, owned: [], enemies: [], sets: [] };
    const bases = baseScores(fixture);
    const fallback = scoreOffer(fixture, bases, new Map(), state, { itemId: 1, enhanced: true });
    expect(fallback.why.join(' ')).toContain('enhanced fallback assumption');
    fixture.enhancedScoring = { itemOverrides: { 1: { properties: { BonusHealth: { value: 200 } }, scoreBonus: 0 } } };
    const explicit = scoreOffer(fixture, bases, new Map(), state, { itemId: 1, enhanced: true });
    expect(explicit.parts.enhanced).toBe(0);
    expect(explicit.parts.kit).toBeCloseTo(0.3);
    expect(explicit.why.join(' ')).toContain('properties supplied by local override');
  });
});
