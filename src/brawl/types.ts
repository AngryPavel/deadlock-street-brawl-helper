import type { Ability, AbilityOrderStat, Hero, Item, ItemStat, PairStat } from '../types';

/** Slim item-stats row from the enemy-filtered `item-stats?enemy_hero_ids=<id>` query. */
export interface VsStat {
  item_id: number;
  wins: number;
  matches: number;
}

/** public/data/analytics/brawl/<hero>.json: one all-rank population (the API has no rank filter for Street Brawl). */
export interface BrawlAnalytics {
  hero_id: number;
  game_mode: 'street_brawl';
  item_stats: ItemStat[];
  permutation_stats: PairStat[];
  /** absent for files written before item 3 (item advice degrades gracefully; no ability-order panel) */
  ability_order_stats?: AbilityOrderStat[];
  /** enemy hero id -> this hero's item stats in matches where that enemy was on the other team */
  vs: Record<string, VsStat[]>;
}

/** public/data/brawl-config.json: the `street_brawl` block of the assets API generic data. */
export interface BrawlConfig {
  gold_per_round: number[];
  buy_time: number[];
  pre_buy_time: number[];
  item_draft_rerolls_per_round: number[];
  round_length_minutes: number[];
  score_to_win: number;
  item_draft_rounds_per_game_round: {
    chance_rare: { outcomes_to_weights: Record<string, number> };
    chance_enhanced: { outcomes_to_weights: Record<string, number> };
    item_draft_rounds: { normal_mod_tier: number; rare_mod_tier: number }[];
  }[];
  item_drafts: Record<string, { bucket: { normal: number; good: number }; name: string }>;
}

export interface BrawlInput {
  hero: Hero;
  abilities: Ability[];
  items: Item[];
  analytics: BrawlAnalytics;
  config: BrawlConfig;
}

/** One card on the draft screen. `enhanced` = the same item with better numbers. */
export interface Offer {
  itemId: number;
  enhanced?: boolean;
}

export interface DraftState {
  round: number; // 1..5
  owned: number[]; // item ids already held (not sold)
  enemies: number[]; // enemy hero ids (0..4 known)
  sets: Offer[][]; // 1..3 sets of up to 3 cards
}

export interface ScoreParts {
  pop: number;
  winLift: number;
  kit: number;
  tier: number;
  counter: number;
  synergy: number;
  active: number;
  upgrade: number;
  enhanced: number;
  dup: number;
}

export interface RankedOffer {
  item: Item;
  enhanced: boolean;
  score: number;
  parts: ScoreParts;
  why: string[];
  usage: number;
  winRate: number | null; // usage relative to the most-picked item of the same tier
  known: boolean; // false when the item has no brawl data
}

/** holdValue: what keeping the re-roll for a later set of this round is worth (0 for the last set). */
export interface RerollAdvice {
  set: number;
  currentBest: number;
  expectedBest: number;
  gain: number;
  holdValue: number;
  pool: { tier: number; pRare: number; rareTier: number };
}

export interface DraftAdvice {
  sets: RankedOffer[][]; // every card scored against `owned`, best first
  picks: RankedOffer[]; // the jointly best one-per-set choice (synergy between picks included)
  reroll: RerollAdvice | null;
}

/** public/data/brawl-icons.json: item id -> base64 RGB bytes of the icon at size x size (see scripts/build-icon-index.mjs). */
export interface IconIndex {
  size: number;
  background: string;
  icons: Record<string, string>;
  extras?: [number, string][]; // extra in-game reference icons: [item id, base64]
  twins?: Record<string, number[]>;
  heroes?: Record<string, string>;
} // twins: items whose icon file is identical; heroes: card-art portraits
