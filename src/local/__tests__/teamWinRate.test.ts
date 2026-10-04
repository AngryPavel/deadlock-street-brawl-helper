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
  it('requires all eight valid heroes, names, and positive valid sample counts', () => {
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
      ).toBeNull();
    expect(teamWinRate(roster, { ...data, heroes: data.heroes.slice(0, 7) }, heroes)).toBeNull();
    expect(teamWinRate(roster, data, heroes.slice(0, 7))).toBeNull();
    expect(
      teamWinRate(
        roster,
        data,
        heroes.map((h) => (h.id === 8 ? { ...h, name: ' ' } : h)),
      ),
    ).toBeNull();
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
});
