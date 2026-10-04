import type { PatchAnnouncement, UpdateRequest } from '../../src/data/updateTypes';

export function patchBoundary(since: string, now = Date.now()): number {
  // API analytics round timestamps to the hour. Round up so pre-patch games cannot leak in.
  if (!/(Z|[+-]\d\d:\d\d)$/.test(since)) throw new Error('Patch time must include a time zone.');
  const time = Date.parse(since);
  const boundary = Math.ceil(time / 3_600_000) * 3600;
  if (!Number.isFinite(time) || boundary <= 0 || boundary * 1000 >= now)
    throw new Error('Patch time must be in the past. Wait until the first complete post-patch hour.');
  return boundary;
}

export function validateRequest(value: unknown): UpdateRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid update request.');
  const v = value as Partial<UpdateRequest>;
  if ((v.mode !== 'full' && v.mode !== 'incremental') || typeof v.since !== 'string')
    throw new Error('Invalid update request.');
  patchBoundary(v.since);
  return { mode: v.mode, since: v.since };
}

interface NewsItem {
  title: string;
  contents?: string;
  date: number;
  url: string;
  feedname: string;
}
export function latestPatch(items: NewsItem[]): PatchAnnouncement | null {
  const candidates = items.filter(
    (n) =>
      n.feedname === 'steam_community_announcements' &&
      (/patch|hotfix|update|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/i.test(n.title) ||
        /\b(?:patch notes|changelog|(?:today.?s|this|new|major|minor|visual|balance) update|available to play now)\b/i.test(
          n.contents ?? '',
        )) &&
      !/tournament|sale|merch|soundtrack/i.test(n.title) &&
      Number.isFinite(n.date),
  );
  const newest = candidates.sort((a, b) => b.date - a.date)[0];
  return newest ? { title: newest.title, timestamp: newest.date, url: newest.url } : null;
}

export interface CounterRow {
  [key: string]: number | number[];
  wins: number;
  losses: number;
  matches: number;
}
export type Counters = Record<string, CounterRow[]>;
export function mergeRows(left: CounterRow[], right: CounterRow[], fields: string[]): CounterRow[] {
  const rows = new Map<string, CounterRow>();
  for (const row of [...left, ...right]) {
    const dimensions = Object.fromEntries(
      fields.map((f) => [f, Array.isArray(row[f]) ? [...row[f]].sort((a, b) => a - b) : row[f]]),
    );
    const key = JSON.stringify(dimensions);
    const target = rows.get(key) ?? { ...dimensions, wins: 0, losses: 0, matches: 0 };
    for (const field of ['wins', 'losses', 'matches'] as const) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw new Error(`Invalid ${field} in API response.`);
      target[field] += row[field];
    }
    rows.set(key, target);
  }
  return [...rows.values()];
}
export function mergeCounters(left: Counters, right: Counters): Counters {
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => [
      key,
      mergeRows(left[key] ?? [], right[key] ?? [], key.startsWith('enemy:') ? ['bucket', 'item_id'] : ['item_ids']),
    ]),
  );
}
