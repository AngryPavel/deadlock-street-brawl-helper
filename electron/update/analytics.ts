import type { HeroStats, RoundItemStats, RoundItemStatsProvenance } from '../../src/data/updateTypes';

export function exactHeroStats(value: unknown): HeroStats {
  const row = value as Partial<HeroStats> | null;
  if (
    !row ||
    !Number.isSafeInteger(row.wins) ||
    !Number.isSafeInteger(row.matches) ||
    row.wins! < 0 ||
    row.matches! < row.wins!
  )
    throw new Error('Invalid hero win/match counts.');
  return { wins: row.wins!, matches: row.matches! };
}

/**
 * Official source: api/src/routes/v1/analytics/item_flow_stats.rs.
 * column is the purchase round, wins is match_player.won, and matches counts purchase rows.
 * In Street Brawl adjusted_win_rate is the raw rate too; do not present it as a causal adjustment.
 */
export function roundItemStats(value: unknown): {
  round_item_stats: RoundItemStats[];
  round_item_stats_provenance: RoundItemStatsProvenance;
} {
  const flow = value as { nodes?: unknown[]; reached_per_column?: unknown[] } | null;
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.reached_per_column))
    throw new Error('Invalid item-flow statistics.');
  const reached = flow.reached_per_column;
  if (reached.length !== 5 || reached.some((n) => !Number.isSafeInteger(n) || Number(n) < 0))
    throw new Error('Item-flow statistics must contain five purchase rounds.');
  const seen = new Set<string>();
  const rows = flow.nodes.map((value) => {
    const row = value as { item_id: number; column: number; wins: number; matches: number };
    const counts = exactHeroStats(row);
    if (
      !Number.isSafeInteger(row.item_id) ||
      row.item_id <= 0 ||
      !Number.isInteger(row.column) ||
      row.column < 0 ||
      row.column >= 5
    )
      throw new Error('Invalid item-flow item or purchase round.');
    const key = `${row.item_id}:${row.column}`;
    if (seen.has(key)) throw new Error('Duplicate item-flow item and purchase round.');
    seen.add(key);
    return { item_id: row.item_id, round: (row.column + 1) as RoundItemStats['round'], ...counts };
  });
  return {
    round_item_stats: rows,
    round_item_stats_provenance: {
      endpoint: '/v1/analytics/item-flow-stats',
      phase_count: 5,
      round_semantics: 'purchase_round',
      outcome_semantics: 'match_win',
      count_semantics: 'purchase',
      reached_per_round: reached as number[],
    },
  };
}
