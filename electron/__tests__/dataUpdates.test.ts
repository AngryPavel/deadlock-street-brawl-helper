import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataUpdater } from '../update/service';
import { latestPatch, mergeCounters, patchBoundary, validateRequest } from '../update/policy';
import type { UpdateProgress } from '../../src/data/updateTypes';
import { exactHeroStats, roundItemStats } from '../update/analytics';
import { fetchCatalog } from '../update/catalog';

vi.mock('../update/catalog', async () => {
  const actual = await vi.importActual<typeof import('../update/catalog')>('../update/catalog');
  return {
    ...actual,
    fetchCatalog: vi.fn(async () => ({ heroes: [{ id: 1, name: 'Hero', abilities: [] }], items: [], abilities: [] })),
    buildIconIndex: vi.fn(async () => {}),
  };
});

describe('patch boundaries and counters', () => {
  it('maps all five purchase columns without calling match wins round wins', () => {
    const flow = roundItemStats({
      nodes: Array.from({ length: 5 }, (_, column) => ({ item_id: 11, column, wins: 2, matches: 7 })),
      reached_per_column: [20, 20, 18, 11, 5],
    });
    expect(flow.round_item_stats.map((row) => row.round)).toEqual([1, 2, 3, 4, 5]);
    expect(flow.round_item_stats[4]).toEqual({ item_id: 11, round: 5, wins: 2, matches: 7 });
    expect(flow.round_item_stats_provenance).toMatchObject({
      phase_count: 5,
      round_semantics: 'purchase_round',
      outcome_semantics: 'match_win',
      count_semantics: 'purchase',
    });
    expect(() => roundItemStats({ nodes: [], reached_per_column: [1, 1, 1, 1] })).toThrow(/five/);
    expect(() =>
      roundItemStats({ nodes: [{ item_id: 1, column: 5, wins: 1, matches: 1 }], reached_per_column: [1, 1, 1, 1, 1] }),
    ).toThrow(/round/);
    expect(() => exactHeroStats({ wins: 6, matches: 5 })).toThrow(/counts/);
  });
  it('rounds forward and rejects future or ambiguous dates', () => {
    expect(patchBoundary('2026-01-02T10:15:00Z', Date.parse('2026-01-03T00:00Z'))).toBe(
      Date.parse('2026-01-02T11:00:00Z') / 1000,
    );
    expect(() => patchBoundary('2026-01-02T10:15')).toThrow(/time zone/);
    expect(() => validateRequest({ mode: 'full', since: '2999-01-01T00:00:00Z' })).toThrow(/past/);
    expect(() => validateRequest({ mode: 'shell', since: '2026-01-01T00:00:00Z' })).toThrow();
  });
  it('finds patch announcements while ignoring unrelated Steam news', () => {
    const rows = [
      {
        title: '10/02/2026 Update',
        date: 20,
        url: 'https://example.com/patch',
        feedname: 'steam_community_announcements',
      },
      {
        title: 'Soundtrack update',
        date: 30,
        url: 'https://example.com/music',
        feedname: 'steam_community_announcements',
      },
    ];
    expect(latestPatch(rows)?.timestamp).toBe(20);
    const major = {
      title: 'City Never Sleeps',
      contents: 'A massive visual update to the map and neutrals, six new heroes.',
      date: 40,
      url: 'https://example.com/major',
      feedname: 'steam_community_announcements',
    };
    const heroRelease = {
      ...major,
      title: 'Listen up, Crumbums! Your King is here.',
      contents: 'The Rat King is available to play now!',
      date: 50,
    };
    expect(latestPatch([...rows, major])?.timestamp).toBe(40);
    expect(latestPatch([...rows, major, heroRelease])?.timestamp).toBe(50);
    expect(latestPatch([{ ...heroRelease, feedname: 'third_party_news' }, ...rows])?.timestamp).toBe(20);
  });
  it('normalizes pair order without adding nonadditive fields', () => {
    const result = mergeCounters(
      { 'pairs:1': [{ item_ids: [2, 1], wins: 2, losses: 1, matches: 3 }] },
      { 'pairs:1': [{ item_ids: [1, 2], wins: 1, losses: 1, matches: 2 }] },
    );
    expect(result['pairs:1']).toEqual([{ item_ids: [1, 2], wins: 3, losses: 2, matches: 5 }]);
    expect(() => mergeCounters({}, { 'pairs:1': [{ item_ids: [1, 2], wins: -1, losses: 1, matches: 0 }] })).toThrow();
  });
});

describe('transactional desktop snapshots', () => {
  let temp: string,
    source: string,
    updates: string,
    progress: UpdateProgress[],
    requests: string[],
    maximum: number,
    fail: boolean,
    failHistorical: boolean;
  const factory = () => ({
    bytes: async () => Buffer.alloc(0),
    json: async <T>(url: string): Promise<T> => {
      requests.push(url);
      if (fail && url.includes('/analytics/')) throw new Error('Offline');
      const parsed = new URL(url),
        min = Number(parsed.searchParams.get('min_match_id')),
        amount = min > 0 ? 3 : 2;
      if (
        failHistorical &&
        parsed.searchParams.get('max_unix_timestamp') === String(Date.parse('2025-12-31T23:00Z') / 1000 - 1)
      )
        throw new Error('Historical server unavailable');
      const row = { wins: amount, losses: 0, matches: amount };
      let value: unknown;
      if (url.includes('recently-fetched')) value = [{ match_id: maximum }];
      else if (url.includes('item-permutation')) value = [{ item_ids: [1, 2], ...row }];
      else if (url.includes('ability-order')) value = [];
      else if (url.includes('item-flow'))
        value = {
          nodes: [{ column: 4, item_id: 1, wins: 1, matches: 2 }],
          reached_per_column: [2, 2, 2, 2, 2],
        };
      else if (url.includes('hero-stats')) value = [{ hero_id: 1, ...row }];
      else if (url.includes('item-stats'))
        value = [
          { bucket: 1, item_id: 1, players: 1, ...row },
          { bucket: 1, item_id: 2, players: 1, ...row },
        ];
      else if (url.includes('generic-data'))
        value = { street_brawl: { item_draft_rerolls_per_round: [1, 1, 1, 1, 1] } };
      else value = { appnews: { newsitems: [] } };
      return value as T;
    },
  });
  const make = () => new DataUpdater(source, updates, factory, (p) => progress.push(p));
  const finished = async () => {
    await vi.waitFor(() => expect(progress.at(-1)?.phase).not.toBe('running'), { timeout: 3000, interval: 10 });
  };
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'brawl-update-test-'));
    source = path.join(temp, 'bundled');
    updates = path.join(temp, 'updates');
    await mkdir(source);
    await writeFile(
      path.join(source, 'manifest.json'),
      JSON.stringify({ fetched_at: '2026-01-01T00:00:00Z', window_days: 30, counts: {} }),
    );
    await writeFile(
      path.join(source, 'brawl-icons.json'),
      JSON.stringify({ size: 24, icons: {}, background: '#ebe8e2' }),
    );
    progress = [];
    requests = [];
    maximum = 50;
    fail = false;
    failHistorical = false;
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  it('publishes only a complete generation and resumes it after restart', async () => {
    const updater = make();
    await updater.initialize();
    expect((await updater.status()).canIncrement).toBe(false);
    updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' });
    await finished();
    expect(progress.at(-1)?.phase).toBe('complete');
    expect((await updater.status()).canIncrement).toBe(true);
    expect(updater.root).not.toBe(source);
    const restarted = make();
    await restarted.initialize();
    expect(restarted.root).toBe(updater.root);
    expect(JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')).brawl).toBeUndefined();
    expect(updater.resolveUrl('brawl-data://snapshot/bundled/manifest.json')).toBe(path.join(source, 'manifest.json'));
    expect(updater.resolveUrl('brawl-data://snapshot/bundled/%2e%2e/secret.txt')).toBeNull();
    expect(updater.resolveUrl('brawl-data://snapshot/bundled/update-state.json')).toBeNull();
    const hero = JSON.parse(await readFile(path.join(updater.root, 'analytics/brawl/1.json'), 'utf8'));
    expect(hero.hero_stats).toEqual({ wins: 2, matches: 2 });
    expect(hero.item_stats.reduce((n: number, row: { matches: number }) => n + row.matches, 0)).toBe(4);
    expect(hero.round_item_stats).toEqual([{ item_id: 1, round: 5, wins: 1, matches: 2 }]);
    expect(hero.stats_window).toMatchObject({
      schema_version: 2,
      role: 'primary',
      patch_id: 'cutoff:2026-01-01T00:00:00.000Z',
    });
    expect(hero.historical_stats_window.role).toBe('historical-prior');
    expect(hero.historical_stats_window.catalog_compatibility).toBe('unverified');
    expect(hero.historical_stats_window.max_unix_timestamp).toBeLessThan(hero.stats_window.min_unix_timestamp);
    for (const url of requests.filter((url) => url.includes('/analytics/'))) {
      const q = new URL(url).searchParams;
      expect(q.get('game_mode')).toBe('street_brawl');
      expect(q.has('max_match_id')).toBe(true);
      expect(q.has('max_unix_timestamp')).toBe(true);
      if (url.includes('item-flow')) {
        expect(q.get('phase_count')).toBe('5');
        expect(q.get('hero_ids')).toBe('1');
        expect(Number(q.get('min_unix_timestamp'))).toBe(hero.stats_window.min_unix_timestamp);
      }
    }
  });
  it('replaces the recent tail, freezes disjoint ranges, and resets on a new patch', async () => {
    const updater = make();
    await updater.initialize();
    updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' });
    await finished();
    const stateFile = path.join(updater.root, 'update-state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    state.tailCreated = 0;
    await writeFile(stateFile, JSON.stringify(state));
    maximum = 70;
    progress = [];
    updater.start({ mode: 'incremental', since: '2026-01-01T00:00:00Z' });
    await finished();
    let updated = JSON.parse(await readFile(path.join(updater.root, 'update-state.json'), 'utf8'));
    expect(updated.tailMinimum).toBe(51);
    expect(updated.frozen['pairs:1'][0].matches).toBe(2);
    expect(requests.some((url) => url.includes('min_match_id=51') && url.includes('max_match_id=70'))).toBe(true);
    progress = [];
    updater.start({ mode: 'incremental', since: '2026-01-01T00:00:00Z' });
    await finished();
    updated = JSON.parse(await readFile(path.join(updater.root, 'update-state.json'), 'utf8'));
    expect(updated.frozen['pairs:1'][0].matches).toBe(2); // unchanged, not added twice
    expect(
      requests
        .filter((url) => url.includes('item-flow'))
        .every((url) => new URL(url).searchParams.get('min_match_id') === '0'),
    ).toBe(true);
    progress = [];
    updater.start({ mode: 'incremental', since: '2026-01-02T00:00:00Z' });
    await finished();
    updated = JSON.parse(await readFile(path.join(updater.root, 'update-state.json'), 'utf8'));
    expect(updated.tailMinimum).toBe(0);
    expect(updated.frozen).toEqual({});
  });
  it('rebuilds the old schema without requiring new fields in the bundled snapshot', async () => {
    await writeFile(
      path.join(source, 'update-state.json'),
      JSON.stringify({ schema: 1, patch: Date.parse('2026-01-01T00:00Z') / 1000, frozen: { broken: true } }),
    );
    const updater = make();
    await updater.initialize();
    expect((await updater.status()).canIncrement).toBe(false);
    updater.start({ mode: 'incremental', since: '2026-01-01T00:00:00Z' });
    await finished();
    expect(progress.at(-1)?.phase).toBe('complete');
    const state = JSON.parse(await readFile(path.join(updater.root, 'update-state.json'), 'utf8'));
    expect(state.schema).toBe(2);
    expect(state.frozen).toEqual({});
  });
  it('publishes primary statistics without prior rows when the optional historical request fails', async () => {
    failHistorical = true;
    const updater = make();
    updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' });
    await finished();
    expect(progress.at(-1)?.phase).toBe('complete');
    expect(progress.at(-1)?.warnings.join(' ')).toMatch(/historical support/);
    const hero = JSON.parse(await readFile(path.join(updater.root, 'analytics/brawl/1.json'), 'utf8'));
    expect(hero.hero_stats).toEqual({ wins: 2, matches: 2 });
    expect(hero.historical_item_stats).toBeUndefined();
    expect(hero.historical_stats_window).toBeUndefined();
  });
  it('does not manufacture hero-games for a hero missing from hero-stats', async () => {
    const catalog = await fetchCatalog(
      source,
      factory(),
      new AbortController().signal,
      () => {},
      () => {},
    );
    vi.mocked(fetchCatalog).mockResolvedValueOnce({
      ...catalog,
      heroes: [...catalog.heroes, { ...catalog.heroes[0]!, id: 2, name: 'Unsampled hero' }],
    });
    const updater = make();
    updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' });
    await finished();
    expect(progress.at(-1)?.phase).toBe('complete');
    const hero = JSON.parse(await readFile(path.join(updater.root, 'analytics/brawl/2.json'), 'utf8'));
    expect(hero.hero_stats).toBeUndefined();
    expect(hero.stats_window.role).toBe('primary');
  });
  it('keeps the active snapshot on failure and rejects concurrent updates', async () => {
    const updater = make();
    await updater.initialize();
    fail = true;
    updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' });
    expect(() => updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' })).toThrow(/already/);
    await finished();
    expect(progress.at(-1)?.phase).toBe('error');
    expect(updater.root).toBe(source);
    await expect(readFile(path.join(updates, 'current.json'))).rejects.toThrow();
  });
  it('cancels without publishing partial data', async () => {
    const updater = make();
    await updater.initialize();
    updater.start({ mode: 'full', since: '2026-01-01T00:00:00Z' });
    updater.cancel();
    await finished();
    expect(progress.at(-1)?.phase).toBe('cancelled');
    expect(updater.root).toBe(source);
  });
});
