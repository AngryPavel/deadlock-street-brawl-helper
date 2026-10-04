import { describe, expect, it } from 'vitest';
import { TeamRosterConfirmation, teamWinRate, type TeamRoster } from '../teamWinRate';
import type { BrawlTierListData } from '../../brawl/tierlist';
import type { DraftMeta } from '../../brawl/recognise';

const roster: TeamRoster = { self: 2, left: [1, 2, 3, 4], right: [5, 6, 7, 8] };
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
  it('takes the unweighted mean of all four including self, with own side detected from the roster', () => {
    const unequal = {
      ...data,
      heroes: data.heroes.map((h) => (h.hero_id === 1 ? { ...h, wins: 90, matches: 100 } : h)),
    };
    expect(teamWinRate(roster, unequal)).toMatchObject({ ownWinRate: 0.675, enemyWinRate: 0.4 });
    expect(teamWinRate(roster, unequal)?.deltaPp).toBeCloseTo(27.5);
    expect(teamWinRate({ ...roster, self: 5 }, unequal)).toMatchObject({ ownWinRate: 0.4, enemyWinRate: 0.675 });
    expect(teamWinRate({ ...roster, self: 5 }, unequal)?.deltaPp).toBeCloseTo(-27.5);
    expect(teamWinRate(roster, data)?.window).toContain('2026-10-02');
  });
  it('requires all eight valid heroes and all eight positive, valid sample counts', () => {
    for (const r of [
      { ...roster, self: 9 },
      { ...roster, left: [1, 2, 3] },
      { ...roster, right: [5, 6, 7, 1] },
    ])
      expect(teamWinRate(r, data)).toBeNull();
    for (const patch of [{ wins: NaN }, { wins: 11 }, { matches: 0 }, { matches: Infinity }])
      expect(
        teamWinRate(roster, { ...data, heroes: data.heroes.map((h) => (h.hero_id === 8 ? { ...h, ...patch } : h)) }),
      ).toBeNull();
    expect(teamWinRate(roster, { ...data, heroes: data.heroes.slice(0, 7) })).toBeNull();
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
