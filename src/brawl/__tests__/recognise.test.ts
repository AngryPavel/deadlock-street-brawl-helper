import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodeIconIndex } from '../recognise';
import { checkFixtures, readFixtureLabels } from '../../../scripts/fixtureCheck';
import { items } from './testData';

// Measured alone these take 1-2 s (recognise: 1.8 s, regions: ~1 s each); with the whole suite running in parallel on a
// busy machine they pass the 5 s default, so this file gets 20 s. Nothing is skipped or weakened.
vi.setConfig({ testTimeout: 20_000 });

const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const tierOf = (id: number) => items.find((i) => i.id === id)?.item_tier ?? 0;

describe('checkFixtures (Node/sharp side of the recogniser, same fixtures as `npm run brawl:see -- --fixtures`)', () => {
  it('recognises 27/27 fixture cards with the expected id, tier, rare and enhanced flags', async () => {
    const labels = readFixtureLabels();
    const results = await checkFixtures(index, tierOf);
    expect(results).toHaveLength(Object.keys(labels).length);
    expect(results.length).toBeGreaterThanOrEqual(27);
    const misses = results.filter((r) => !r.hit).map((r) => r.key);
    expect(misses).toEqual([]);
  });
});
