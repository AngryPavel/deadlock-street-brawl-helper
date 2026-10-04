import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataUpdater } from '../update/service';
import { latestPatch, mergeCounters, patchBoundary, validateRequest } from '../update/policy';
import type { UpdateProgress } from '../../src/data/updateTypes';

vi.mock('../update/catalog', async () => {
  const actual = await vi.importActual<typeof import('../update/catalog')>('../update/catalog');
  return {
    ...actual,
    fetchCatalog: vi.fn(async () => ({ heroes: [{ id: 1, name: 'Hero', abilities: [] }], items: [], abilities: [] })),
    buildIconIndex: vi.fn(async () => {}),
  };
});

describe('patch boundaries and counters', () => {
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
    fail: boolean;
  const factory = () => ({
    bytes: async () => Buffer.alloc(0),
    json: async <T>(url: string): Promise<T> => {
      requests.push(url);
      if (fail && url.includes('/analytics/')) throw new Error('Offline');
      const parsed = new URL(url),
        min = Number(parsed.searchParams.get('min_match_id')),
        amount = min > 0 ? 3 : 2;
      const row = { wins: amount, losses: 0, matches: amount };
      let value: unknown;
      if (url.includes('recently-fetched')) value = [{ match_id: maximum }];
      else if (url.includes('item-permutation')) value = [{ item_ids: [1, 2], ...row }];
      else if (url.includes('ability-order')) value = [];
      else if (url.includes('hero-stats')) value = [{ hero_id: 1, ...row }];
      else if (url.includes('item-stats')) value = [{ bucket: 1, item_id: 1, players: 1, ...row }];
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
    progress = [];
    updater.start({ mode: 'incremental', since: '2026-01-02T00:00:00Z' });
    await finished();
    updated = JSON.parse(await readFile(path.join(updater.root, 'update-state.json'), 'utf8'));
    expect(updated.tailMinimum).toBe(0);
    expect(updated.frozen).toEqual({});
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
