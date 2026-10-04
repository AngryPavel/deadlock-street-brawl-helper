import type { BrawlAnalytics } from '../brawl/types';

export interface Counts {
  wins: number;
  matches: number;
}
export const validCounts = (row: Counts | undefined): row is Counts =>
  !!row &&
  Number.isFinite(row.matches) &&
  row.matches > 0 &&
  Number.isFinite(row.wins) &&
  row.wins >= 0 &&
  row.wins <= row.matches;

/** Never sum item rows: a hero-game can contribute to many of them. */
export function heroBaseline(analytics: BrawlAnalytics): number {
  return validCounts(analytics.hero_stats) ? analytics.hero_stats.wins / analytics.hero_stats.matches : 0.5;
}

/** Historical evidence is optional, disjoint, bounded, and always weaker than current evidence. */
export function historicalPrior(
  analytics: BrawlAnalytics,
  itemId: number,
  currentMatches: number,
): { matches: number; rate: number } {
  const primary = analytics.stats_window;
  const historical = analytics.historical_stats_window;
  const row = analytics.historical_item_stats?.find((r) => r.item_id === itemId);
  if (
    !primary ||
    primary.role !== 'primary' ||
    !historical ||
    historical.role !== 'historical-prior' ||
    historical.max_unix_timestamp >= primary.min_unix_timestamp ||
    !validCounts(row)
  )
    return { matches: 0, rate: 0.5 };
  return { matches: Math.min(50, currentMatches / 2, row.matches), rate: row.wins / row.matches };
}

export function smoothedRate(
  row: Counts,
  baseline: number,
  strength: number,
  prior = { matches: 0, rate: 0.5 },
): number {
  return (row.wins + strength * baseline + prior.matches * prior.rate) / (row.matches + strength + prior.matches);
}

/** Purchase phase, match outcome, and purchase counts: no round-win or causal interpretation. */
export function roundStatsAvailable(analytics: BrawlAnalytics): boolean {
  const provenance = analytics.round_item_stats_provenance;
  return (
    provenance?.round_semantics === 'purchase_round' &&
    provenance.outcome_semantics === 'match_win' &&
    provenance.count_semantics === 'purchase'
  );
}
