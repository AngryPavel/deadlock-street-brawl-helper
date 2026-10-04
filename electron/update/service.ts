import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DataStatus,
  PatchAnnouncement,
  StatsWindow,
  UpdateProgress,
  UpdateRequest,
} from '../../src/data/updateTypes';
import type { Manifest } from '../../src/data/load';
import type { Hero } from '../../src/types';
import type { IconIndex } from '../../src/brawl/types';
import { buildIconIndex, fetchCatalog, saveJson, type CatalogHttp } from './catalog';
import { latestPatch, mergeCounters, patchBoundary, validateRequest, type Counters } from './policy';
import { exactHeroStats, roundItemStats } from './analytics';

const API = 'https://api.deadlock-api.com';
const SCHEMA = 2;
interface State {
  schema: number;
  patch: number;
  roster: number[];
  maximum: number;
  frozen: Counters;
  tailMinimum: number;
  tailCreated: number;
}
interface Pointer {
  generation: string;
}
type Stats = Record<string, any[]>;
interface StatisticsJob {
  key: string;
  label: string;
  url: string;
  parse?: (value: unknown) => any[];
  optional?: boolean;
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
const idle = (): UpdateProgress => ({
  phase: 'idle',
  stage: 'Ready',
  completed: 0,
  total: 0,
  percent: 0,
  elapsedSeconds: 0,
  etaSeconds: null,
  message: 'Ready to update.',
  warnings: [],
});

/** A complete generation is published with a single atomic pointer replacement. Never modifies app.asar. */
export class DataUpdater {
  private generation = 'bundled';
  private aborter: AbortController | null = null;
  private started = 0;
  private stageStarted = 0;
  private patch: PatchAnnouncement | null = null;
  private patchError: string | null = null;
  private progress = idle();
  private patchCheckedAt = 0;
  private patchCheck: Promise<void> | null = null;
  private statisticsUpperBound = 0;
  constructor(
    readonly bundled: string,
    readonly directory: string,
    private httpFactory: (signal: AbortSignal, notify: (message: string) => void) => CatalogHttp,
    private emit: (progress: UpdateProgress) => void,
  ) {}
  get root() {
    return this.generation === 'bundled' ? this.bundled : path.join(this.directory, 'snapshots', this.generation);
  }
  get currentProgress() {
    return structuredClone(this.progress);
  }
  async initialize() {
    try {
      const pointer = await readJson<Pointer>(path.join(this.directory, 'current.json'));
      if (!/^snapshot-[a-f0-9-]+$/.test(pointer.generation)) throw new Error('Invalid snapshot pointer.');
      await readJson(path.join(this.directory, 'snapshots', pointer.generation, 'manifest.json'));
      this.generation = pointer.generation;
    } catch {
      /* first run or unreadable pointer: shipped snapshot remains available */
    }
  }
  /** Restricts the custom data protocol to catalog assets, without arbitrary file access. */
  resolveUrl(url: string): string | null {
    const parsed = new URL(url);
    const segments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean);
    const [generation, ...rest] = segments;
    if (
      parsed.protocol !== 'brawl-data:' ||
      parsed.hostname !== 'snapshot' ||
      !generation ||
      (generation !== 'bundled' && !/^snapshot-[a-f0-9-]+$/.test(generation))
    )
      return null;
    const rel = rest.join('/');
    if (
      !/^(?:manifest|items|heroes|abilities|brawl-config|brawl-icons)\.json$/.test(rel) &&
      !/^analytics\/brawl\/(?:\d+|tier-list)\.json$/.test(rel) &&
      !/^img\/(?:items|heroes|abilities)\/\d+(?:-card)?\.webp$/.test(rel)
    )
      return null;
    return path.join(generation === 'bundled' ? this.bundled : path.join(this.directory, 'snapshots', generation), rel);
  }
  async status(checkPatch = false): Promise<DataStatus> {
    if (checkPatch && Date.now() - this.patchCheckedAt > 30 * 60 * 1000) {
      this.patchCheck ??= this.checkPatch().finally(() => {
        this.patchCheck = null;
      });
      await this.patchCheck;
    }
    const manifest = await readJson<Manifest>(path.join(this.root, 'manifest.json'));
    let state: State | null = null;
    try {
      state = await readJson<State>(path.join(this.root, 'update-state.json'));
    } catch {
      /* no incremental base */
    }
    return {
      baseUrl: `brawl-data://snapshot/${this.generation}/`,
      fetchedAt: manifest.brawl?.fetched_at ?? manifest.fetched_at,
      sincePatch: manifest.brawl?.since_patch ?? null,
      latestPatch: this.patch,
      patchCheckError: this.patchError,
      canIncrement: state?.schema === SCHEMA,
    };
  }
  private async checkPatch() {
    this.patchCheckedAt = Date.now();
    try {
      const http = this.httpFactory(new AbortController().signal, () => {});
      const news = await http.json<{ appnews: { newsitems: Parameters<typeof latestPatch>[0] } }>(
        'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=1422450&count=50&maxlength=0',
      );
      this.patch = latestPatch(news.appnews.newsitems);
      this.patchError = null;
    } catch {
      this.patchError = 'Could not check Steam patch announcements. You can still update using a confirmed patch time.';
    }
  }
  start(value: unknown): UpdateProgress {
    if (this.aborter) throw new Error('An update is already running.');
    const request = validateRequest(value);
    this.aborter = new AbortController();
    this.started = this.stageStarted = Date.now();
    this.progress = {
      ...idle(),
      phase: 'running',
      stage: 'Preparing',
      message: 'Preparing a separate snapshot. Your current data remains available.',
    };
    this.emit(this.currentProgress);
    const signal = this.aborter.signal;
    void this.run(request, signal)
      .then(() => {
        this.progress = {
          ...this.progress,
          phase: 'complete',
          stage: 'Complete',
          percent: 100,
          etaSeconds: 0,
          message: 'Data updated. Apply the new snapshot when you are ready.',
        };
      })
      .catch((error) => {
        this.progress = {
          ...this.progress,
          phase: signal.aborted ? 'cancelled' : 'error',
          stage: signal.aborted ? 'Cancelled' : 'Update failed',
          etaSeconds: null,
          message: signal.aborted
            ? 'Update cancelled. Your previous snapshot is unchanged.'
            : `${String(error)} Your previous snapshot is unchanged.`,
        };
      })
      .finally(() => {
        this.aborter = null;
        this.progress.elapsedSeconds = Math.floor((Date.now() - this.started) / 1000);
        this.emit(this.currentProgress);
      });
    return this.currentProgress;
  }
  cancel() {
    this.aborter?.abort();
    return this.currentProgress;
  }
  private report(stage: string, completed: number, total: number, message: string, base: number, span: number) {
    if (this.progress.stage !== stage) this.stageStarted = Date.now();
    const elapsed = (Date.now() - this.stageStarted) / 1000;
    this.progress = {
      ...this.progress,
      stage,
      completed,
      total,
      percent: Math.floor(base + (total ? completed / total : 0) * span),
      elapsedSeconds: Math.floor((Date.now() - this.started) / 1000),
      etaSeconds: completed > 0 ? Math.ceil((elapsed / completed) * (total - completed)) : null,
      message,
    };
    this.emit(this.currentProgress);
  }
  private warn(message: string) {
    this.progress.warnings = [...this.progress.warnings.slice(-19), message];
  }
  private query(
    endpoint: string,
    patch: number,
    minimum: number,
    maximum: number,
    extra: Record<string, string | number> = {},
  ) {
    const q = new URLSearchParams({
      game_mode: 'street_brawl',
      min_unix_timestamp: String(patch),
      // The API rounds max up to the next hour (even for an aligned input). Record its effective bound.
      max_unix_timestamp: String(this.statisticsUpperBound - 1),
      min_match_id: String(minimum),
      max_match_id: String(maximum),
    });
    for (const [key, value] of Object.entries(extra)) q.set(key, String(value));
    return `${API}/v1/analytics/${endpoint}?${q}`;
  }
  private counters(heroes: Hero[], patch: number, minimum: number, maximum: number) {
    const ids = heroes.map((h) => h.id).join(',');
    return heroes.flatMap((h) => [
      {
        key: `enemy:${h.id}`,
        label: `Matchups against ${h.name}`,
        url: this.query('item-stats', patch, minimum, maximum, {
          bucket: 'hero',
          hero_ids: ids,
          enemy_hero_ids: h.id,
          min_matches: 1,
        }),
      },
      {
        key: `pairs:${h.id}`,
        label: `Item pairs for ${h.name}`,
        url: this.query('item-permutation-stats', patch, minimum, maximum, {
          hero_ids: h.id,
          comb_size: 2,
          min_matches: 1,
        }),
      },
    ]);
  }
  private async batch(
    http: CatalogHttp,
    jobs: StatisticsJob[],
    signal: AbortSignal,
    base: number,
    span: number,
  ): Promise<Stats> {
    const result: Stats = {};
    let next = 0,
      completed = 0;
    let failure: unknown = null;
    const heartbeat = setInterval(
      () => this.report('Statistics', completed, jobs.length, 'Waiting for the analytics server…', base, span),
      5000,
    );
    try {
      await Promise.allSettled(
        Array.from({ length: Math.min(3, jobs.length) }, async () => {
          while (next < jobs.length && !failure) {
            signal.throwIfAborted();
            const job = jobs[next++]!;
            let rows: any[];
            try {
              const value = await http.json<unknown>(job.url);
              rows = job.parse ? job.parse(value) : (value as any[]);
              if (!Array.isArray(rows)) throw new Error(`Invalid statistics: ${job.label}.`);
            } catch (error) {
              if (job.optional && !signal.aborted) {
                this.warn(`${job.label} unavailable; no historical support will be used.`);
                this.report('Statistics', ++completed, jobs.length, job.label, base, span);
                continue;
              }
              failure = error;
              return;
            }
            result[job.key] = rows;
            this.report('Statistics', ++completed, jobs.length, job.label, base, span);
          }
        }),
      );
      if (failure) throw failure;
      signal.throwIfAborted();
    } finally {
      clearInterval(heartbeat);
    }
    return result;
  }
  private async run(request: UpdateRequest, signal: AbortSignal) {
    const patch = patchBoundary(request.since),
      now = Math.floor(Date.now() / 1000);
    this.statisticsUpperBound = Math.floor(now / 3600) * 3600 + 3600;
    const source = this.root,
      generation = `snapshot-${randomUUID()}`,
      stage = path.join(this.directory, 'snapshots', generation);
    const http = this.httpFactory(signal, (message) =>
      this.report(this.progress.stage, this.progress.completed, this.progress.total, message, this.progress.percent, 0),
    );
    let installed = false;
    try {
      await mkdir(path.dirname(stage), { recursive: true });
      await cp(source, stage, { recursive: true });
      const recent = await http.json<{ match_id: number }[]>(`${API}/v1/matches/recently-fetched`);
      let maximum = Math.max(...recent.map((row) => row.match_id));
      if (!Number.isSafeInteger(maximum) || maximum <= 0)
        throw new Error('No recent matches available. Try again later.');
      let old: State | null = null;
      try {
        old = await readJson<State>(path.join(source, 'update-state.json'));
      } catch {
        /* shipped snapshot has no counters */
      }
      let incremental = request.mode === 'incremental' && old?.schema === SCHEMA && old.patch === patch;
      if (incremental) maximum = Math.max(maximum, old!.maximum);
      this.report('Catalog', 0, 1, 'Refreshing heroes, items, abilities and their images…', 2, 0);
      const catalog = await fetchCatalog(
        stage,
        http,
        signal,
        (done, total, message) => this.report('Catalog', done, total, message, 2, 33),
        (message) => this.warn(message),
      );
      const roster = catalog.heroes.map((h) => h.id);
      if (incremental && JSON.stringify(roster) !== JSON.stringify(old!.roster)) incremental = false;
      this.report(
        'Statistics',
        0,
        1,
        incremental
          ? 'Replacing the recent batch; older batches stay frozen.'
          : 'Collecting a complete post-patch snapshot.',
        35,
        0,
      );
      let frozen: Counters = incremental ? old!.frozen : {},
        minimum = incremental ? old!.tailMinimum : 0,
        created = incremental ? old!.tailCreated : now;
      if (incremental && now - created >= 48 * 3600 && maximum > old!.maximum) {
        const previous = await this.batch(
          http,
          this.counters(catalog.heroes, patch, minimum, old!.maximum),
          signal,
          35,
          10,
        );
        frozen = mergeCounters(frozen, previous as Counters);
        minimum = old!.maximum + 1;
        created = now;
      }
      const ids = roster.join(',');
      const historicalMinimum = patch - 30 * 86400;
      // max timestamps are inclusive and rounded up by the API. Leave the final pre-patch hour out.
      const historicalMaximum = patch - 3600;
      const jobs: StatisticsJob[] = [
        ...this.counters(catalog.heroes, patch, minimum, maximum),
        {
          key: 'items',
          label: 'Item win rates and distinct players',
          url: this.query('item-stats', patch, 0, maximum, { bucket: 'hero', hero_ids: ids, min_matches: 1 }),
        },
        { key: 'heroes', label: 'Hero win rates', url: this.query('hero-stats', patch, 0, maximum) },
        {
          key: 'historical_items',
          label: 'Optional historical item support',
          optional: true,
          url: this.query('item-stats', historicalMinimum, 0, maximum, {
            bucket: 'hero',
            hero_ids: ids,
            min_matches: 1,
            max_unix_timestamp: historicalMaximum - 1,
          }),
          parse: (value) => {
            if (!Array.isArray(value)) throw new Error('Invalid historical item statistics.');
            return value.map((row) => {
              if (!Number.isSafeInteger(row.bucket) || !Number.isSafeInteger(row.item_id) || row.item_id <= 0)
                throw new Error('Invalid historical item identity.');
              return { bucket: row.bucket, item_id: row.item_id, ...exactHeroStats(row) };
            });
          },
        },
        ...catalog.heroes.map((h) => ({
          key: `rounds:${h.id}`,
          label: `Purchase-round statistics for ${h.name}`,
          // Full bounded range each time: flow response rates and distinct counts are not additive.
          url: this.query('item-flow-stats', patch, 0, maximum, { hero_ids: h.id, phase_count: 5, min_matches: 1 }),
          parse: (value: unknown) => [roundItemStats(value)],
        })),
        ...catalog.heroes.map((h) => ({
          key: `abilities:${h.id}`,
          label: `Ability orders for ${h.name}`,
          url: this.query('ability-order-stats', patch, 0, maximum, { hero_id: h.id, min_matches: 1 }),
        })),
      ];
      const fetched = await this.batch(http, jobs, signal, 45, 45);
      const config = await http.json<{ street_brawl: Record<string, unknown> }>(`${API}/v1/assets/generic-data`);
      if (!config.street_brawl) throw new Error('Street Brawl configuration is unavailable.');
      await saveJson(stage, 'brawl-config.json', { fetched_at: iso(now), ...config.street_brawl });
      const tail = Object.fromEntries(
        Object.entries(fetched).filter(([k]) => k.startsWith('enemy:') || k.startsWith('pairs:')),
      ) as Counters;
      const counters = mergeCounters(frozen, tail);
      const heroRows = fetched
        .heroes!.filter((row) => roster.includes(row.hero_id))
        .map((row) => ({ hero_id: row.hero_id, ...exactHeroStats(row), losses: row.matches - row.wins }));
      const games = heroRows.reduce((sum, row) => sum + row.matches, 0);
      if (!Number.isSafeInteger(games) || games <= 0)
        throw new Error('No post-patch matches yet. Try again once matches have been indexed.');
      const totals = new Map<number, any>();
      const statsWindow: StatsWindow = {
        schema_version: SCHEMA,
        role: 'primary',
        patch_id: `cutoff:${iso(patch)}`,
        min_unix_timestamp: patch,
        max_unix_timestamp: this.statisticsUpperBound,
        max_match_id: maximum,
        fetched_at: iso(now),
        catalog_fetched_at: iso(now),
        catalog_compatibility: 'current',
        ...(this.patch && Math.ceil(this.patch.timestamp / 3600) * 3600 === patch
          ? { patch_announcement: this.patch }
          : {}),
      };
      const historicalWindow: StatsWindow = {
        ...statsWindow,
        role: 'historical-prior',
        patch_id: null,
        min_unix_timestamp: historicalMinimum,
        max_unix_timestamp: historicalMaximum,
        catalog_compatibility: 'unverified',
      };
      delete historicalWindow.patch_announcement;
      for (const hero of catalog.heroes) {
        const heroStats = heroRows.find((row) => row.hero_id === hero.id);
        const items = fetched.items!.filter((row) => row.bucket === hero.id).map((row) => ({ ...row, bucket: 0 }));
        const vs = Object.fromEntries(
          catalog.heroes
            .filter((h) => h.id !== hero.id)
            .map((enemy) => [
              enemy.id,
              (counters[`enemy:${enemy.id}`] ?? [])
                .filter((row) => row.bucket === hero.id)
                .map(({ item_id, wins, matches }) => ({ item_id, wins, matches })),
            ]),
        );
        const pairs = (counters[`pairs:${hero.id}`] ?? [])
          .filter((row) => row.matches >= 20)
          .sort((a, b) => b.matches - a.matches)
          .slice(0, 600);
        const abilities = fetched[`abilities:${hero.id}`]!.filter((row) => row.matches >= 5)
          .sort((a, b) => b.matches - a.matches)
          .slice(0, 200);
        await saveJson(stage, `analytics/brawl/${hero.id}.json`, {
          hero_id: hero.id,
          game_mode: 'street_brawl',
          stats_window: statsWindow,
          // A missing hero row remains missing, never replaced by the sum of item samples.
          ...(heroStats ? { hero_stats: { wins: heroStats.wins, matches: heroStats.matches } } : {}),
          ...fetched[`rounds:${hero.id}`]![0],
          ...(fetched.historical_items
            ? {
                historical_item_stats: fetched.historical_items
                  .filter((row) => row.bucket === hero.id)
                  .map(({ item_id, wins, matches }) => ({ item_id, wins, matches })),
                historical_stats_window: historicalWindow,
              }
            : {}),
          item_stats: items,
          permutation_stats: pairs,
          ability_order_stats: abilities,
          vs,
        });
        for (const row of items) {
          const target = totals.get(row.item_id) ?? {
            item_id: row.item_id,
            wins: 0,
            losses: 0,
            matches: 0,
            players: 0,
          };
          for (const field of ['wins', 'losses', 'matches', 'players']) {
            if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw new Error(`Invalid item ${field}.`);
            target[field] += row[field];
          }
          totals.set(row.item_id, target);
        }
      }
      const brawl = {
        fetched_at: iso(now),
        game_mode: 'street_brawl',
        heroes: roster.length,
        min_unix_timestamp: patch,
        max_unix_timestamp: this.statisticsUpperBound,
        max_match_id: maximum,
        window_days: Math.round((now - patch) / 86400),
        since_patch: iso(patch),
        stats_window: statsWindow,
        ...(fetched.historical_items ? { historical_stats_window: historicalWindow } : {}),
      };
      await saveJson(stage, 'analytics/brawl/tier-list.json', {
        ...brawl,
        hero_games: games,
        heroes: heroRows,
        items: [...totals.values()].sort((a, b) => b.matches - a.matches),
      });
      const manifest = await readJson<Manifest>(path.join(source, 'manifest.json'));
      await saveJson(stage, 'manifest.json', {
        ...manifest,
        catalog_fetched_at: iso(now),
        counts: {
          ...manifest.counts,
          heroes: roster.length,
          items: catalog.items.length,
          abilities: catalog.abilities.length,
        },
        brawl,
      });
      await saveJson(stage, 'update-state.json', {
        schema: SCHEMA,
        patch,
        roster,
        maximum,
        frozen,
        tailMinimum: minimum,
        tailCreated: created,
      } satisfies State);
      this.report('Icon index', 0, 1, 'Building the refreshed recognition index…', 90, 6);
      const previous = await readJson<IconIndex>(path.join(source, 'brawl-icons.json'));
      await buildIconIndex(stage, catalog.items, catalog.heroes, previous, signal);
      this.report('Installing', 0, 1, 'Publishing the verified snapshot…', 96, 3);
      signal.throwIfAborted();
      const temporary = path.join(this.directory, `current-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ generation }));
      signal.throwIfAborted();
      await rename(temporary, path.join(this.directory, 'current.json'));
      this.generation = generation;
      installed = true;
    } finally {
      if (!installed) await rm(stage, { recursive: true, force: true });
    }
  }
}
