/** Shared renderer/main-process contract. Updates never execute renderer-supplied commands or paths. */
export interface PatchAnnouncement {
  title: string;
  timestamp: number;
  url: string;
}
export interface DataStatus {
  baseUrl: string;
  fetchedAt: string | null;
  sincePatch: string | null;
  latestPatch: PatchAnnouncement | null;
  patchCheckError: string | null;
  canIncrement: boolean;
}
export interface UpdateRequest {
  mode: 'full' | 'incremental';
  since: string;
}
export interface UpdateProgress {
  phase: 'idle' | 'running' | 'complete' | 'cancelled' | 'error';
  stage: string;
  completed: number;
  total: number;
  percent: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  message: string;
  warnings: string[];
}

/** A cutoff identifier, not a claim that the API exposes a Valve build/patch identifier. */
export interface StatsWindow {
  schema_version: 2;
  role: 'primary' | 'historical-prior';
  patch_id: string | null;
  min_unix_timestamp: number;
  /** Effective inclusive API bound, after its hour rounding. */
  max_unix_timestamp: number;
  max_match_id?: number;
  fetched_at: string;
  catalog_fetched_at: string;
  /** Historical item IDs do not prove that their past properties match today's catalog. */
  catalog_compatibility: 'current' | 'unverified';
  patch_announcement?: PatchAnnouncement;
}

/** Exact hero-games from hero-stats; item rows must never be summed to manufacture this denominator. */
export interface HeroStats {
  wins: number;
  matches: number;
}

export interface RoundItemStats extends HeroStats {
  item_id: number;
  /** One-based purchase round. The outcome is the entire match, not this round. */
  round: 1 | 2 | 3 | 4 | 5;
}

export interface RoundItemStatsProvenance {
  endpoint: '/v1/analytics/item-flow-stats';
  phase_count: 5;
  round_semantics: 'purchase_round';
  outcome_semantics: 'match_win';
  /** Flow nodes count purchase rows, including only purchases with a recorded positive net worth. */
  count_semantics: 'purchase';
  /** Distinct hero-games buying any upgrade in each round; this is not a count of round victories. */
  reached_per_round: number[];
}

/** Optional additions keep older bundled and runtime snapshots readable. Missing data is not zero evidence. */
export interface PatchAnalytics {
  stats_window?: StatsWindow;
  hero_stats?: HeroStats;
  round_item_stats?: RoundItemStats[];
  round_item_stats_provenance?: RoundItemStatsProvenance;
  historical_item_stats?: { item_id: number; wins: number; matches: number }[];
  historical_stats_window?: StatsWindow;
}
