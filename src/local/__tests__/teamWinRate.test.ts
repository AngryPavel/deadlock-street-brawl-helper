import { describe, expect, it } from 'vitest';
import { TeamRosterConfirmation, teamWinRate, type TeamRoster } from '../teamWinRate';
import type { BrawlTierListData } from '../../brawl/tierlist';
import type { DraftMeta } from '../../brawl/recognise';

const roster: TeamRoster = { self: 2, left: [1, 2, 3, 4], right: [5, 6, 7, 8] };
const heroes = ['Abrams', 'Bebop', 'Dynamo', 'Grey Talon', 'Haze', 'Infernus', 'Ivy', 'Kelvin'].map((name, i) => ({
  id: i + 1,
  name,
}));
const data = {
  game_mode: 'street_brawl',
  fetched_at: '2026-10-04T00:00:00Z',
  min_unix_timestamp: 1790974800,
  max_unix_timestamp: null,
  heroes: [1, 2, 3, 4, 5, 6, 7, 8].map((hero_id) => ({ hero_id, wins: hero_id <= 4 ? 6 : 4, matches: 10, losses: 0 })),
} as BrawlTierListData;
const meta = (r: TeamRoster) =>
  ({
    self: r.self,
    bar: {
      left: r.left.map((heroId) => ({ heroId })),
      right: r.right.map((heroId) => ({ heroId })),
    },
  }) as DraftMeta;
describe('team average hero win rates', () => {
  it('keeps all eight names and rates in roster order and uses the unweighted mean including self', () => {
    const unequal = {
      ...data,
      heroes: data.heroes.map((h) => (h.hero_id === 1 ? { ...h, wins: 90, matches: 100 } : h)),
    };
    const edge = teamWinRate(roster, unequal, heroes)!;
    expect(edge).toMatchObject({ ownWinRate: 0.675, enemyWinRate: 0.4 });
    expect(edge.deltaPp).toBeCloseTo(27.5);
    expect(edge.ownHeroes).toEqual([
      { heroId: 1, name: 'Abrams', winRate: 0.9 },
      { heroId: 2, name: 'Bebop', winRate: 0.6 },
      { heroId: 3, name: 'Dynamo', winRate: 0.6 },
      { heroId: 4, name: 'Grey Talon', winRate: 0.6 },
    ]);
    expect(edge.enemyHeroes).toEqual(heroes.slice(4).map((h) => ({ heroId: h.id, name: h.name, winRate: 0.4 })));
    const reversed = teamWinRate({ ...roster, self: 5 }, unequal, heroes)!;
    expect(reversed).toMatchObject({ ownWinRate: 0.4, enemyWinRate: 0.675 });
    expect(reversed.deltaPp).toBeCloseTo(-27.5);
    expect(reversed.ownHeroes).toEqual(edge.enemyHeroes);
    expect(reversed.enemyHeroes).toEqual(edge.ownHeroes);
    expect(edge.window).toContain('2026-10-02');
  });
  it('requires a confirmed side and valid roster, and keeps unavailable data explicit without team means', () => {
    for (const r of [
      { ...roster, self: 9 },
      { ...roster, left: [1, 2, 3] },
      { ...roster, right: [5, 6, 7, 1] },
    ])
      expect(teamWinRate(r, data, heroes)).toBeNull();
    for (const patch of [{ wins: NaN }, { wins: 11 }, { matches: 0 }, { matches: Infinity }])
      expect(
        teamWinRate(
          roster,
          { ...data, heroes: data.heroes.map((h) => (h.hero_id === 8 ? { ...h, ...patch } : h)) },
          heroes,
        ),
      ).toMatchObject({ ownWinRate: 0.6, enemyWinRate: null, deltaPp: null });
    expect(teamWinRate(roster, { ...data, heroes: data.heroes.slice(0, 7) }, heroes)?.enemyHeroes[3]).toMatchObject({
      name: 'Kelvin',
      winRate: null,
      unavailable: 'missing-data',
    });
    expect(teamWinRate(roster, data, heroes.slice(0, 7))?.enemyHeroes[3]).toMatchObject({
      winRate: null,
      unavailable: 'missing-data',
    });
    expect(
      teamWinRate(
        roster,
        data,
        heroes.map((h) => (h.id === 8 ? { ...h, name: ' ' } : h)),
      ),
    ).toMatchObject({ ownWinRate: 0.6, enemyWinRate: null, deltaPp: null });
    expect(teamWinRate({ ...roster, self: 0 }, data, heroes)).toBeNull();
    expect(teamWinRate(roster, null, heroes)?.ownHeroes[0]).toMatchObject({
      name: 'Abrams',
      winRate: null,
      unavailable: 'loading-data',
    });
  });
  it('confirms two independent complete roster reads and holds through partial tooltips until reset', () => {
    const confirmation = new TeamRosterConfirmation();
    confirmation.observe(meta(roster));
    expect(confirmation.value).toBeNull();
    confirmation.observe(meta({ ...roster, left: [1, 2, 3, 9] }));
    expect(confirmation.value).toBeNull();
    confirmation.observe(meta(roster));
    confirmation.observe(meta(roster));
    expect(confirmation.value).toEqual(roster);
    confirmation.observe(meta({ ...roster, left: [1, 0, 0, 0] }));
    expect(confirmation.value).toEqual(roster);
    confirmation.reset();
    expect(confirmation.value).toBeNull();
  });
  it('confirms a partial lineup without guessing the missing hero, and keeps retrying until it becomes complete', () => {
    const confirmation = new TeamRosterConfirmation();
    const partial = { ...roster, left: [1, 2, 3, 0] };
    confirmation.observe(meta(partial));
    expect(confirmation.value).toBeNull();
    confirmation.observe(meta(partial));
    expect(confirmation.value).toEqual(partial);
    expect(confirmation.complete).toBe(false);
    const edge = teamWinRate(confirmation.value, data, heroes)!;
    expect(edge.ownHeroes[3]).toEqual({ heroId: 0, name: 'Reading hero', winRate: null, unavailable: 'reading-hero' });
    expect(edge.ownHeroes[0]!.winRate).toBe(0.6);
    expect(edge).toMatchObject({ ownWinRate: null, enemyWinRate: 0.4, deltaPp: null });
    expect(teamWinRate({ ...partial, self: 5 }, data, heroes)).toMatchObject({
      ownWinRate: 0.4,
      enemyWinRate: null,
      deltaPp: null,
    });
    confirmation.observe(meta(roster));
    confirmation.observe(meta(roster));
    expect(confirmation.complete).toBe(true);
    expect(teamWinRate(confirmation.value, data, heroes)!.deltaPp).toBeCloseTo(20);
  });
  it('does not borrow a portrait into a duplicate slot when a partial lineup moves', () => {
    const confirmation = new TeamRosterConfirmation();
    const previous = { self: 1, left: [1, 2, 0, 4], right: [5, 6, 7, 8] };
    confirmation.observe(meta(previous));
    confirmation.observe(meta(previous));
    const fresh = { ...previous, left: [1, 0, 2, 4] };
    confirmation.observe(meta(fresh));
    confirmation.observe(meta(fresh));
    expect(confirmation.value).toEqual(fresh);
    expect(teamWinRate(confirmation.value, data, heroes)).toBeTruthy();
    expect(confirmation.complete).toBe(false);
  });
  it('replaces a changed confirmed lineup with partial current evidence without importing old unknown slots', () => {
    const confirmation = new TeamRosterConfirmation();
    confirmation.observe(meta(roster));
    confirmation.observe(meta(roster));
    const changed = { ...roster, right: [5, 6, 9, 0] };
    confirmation.observe(meta(changed));
    expect(confirmation.value).toEqual(roster);
    confirmation.observe(meta(changed));
    expect(confirmation.value).toEqual(changed);
    expect(confirmation.complete).toBe(false);
    expect(teamWinRate(confirmation.value, data, heroes)?.deltaPp).toBeNull();
    confirmation.reset();
    expect(confirmation.value).toBeNull();
  });
});
