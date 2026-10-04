import type { BrawlInput, RankedOffer, RerollAdvice } from '../brawl/types';
import { roundStatsAvailable, validCounts } from './scoringEvidence';

/** Qualitative model evidence; score gaps are not calibrated probabilities of winning. */
export function adviceConfidence(
  input: BrawlInput,
  ranked: RankedOffer[],
  reroll: RerollAdvice | null,
  round: number,
): string {
  if (!ranked.length) return '';
  const notes: string[] = [];
  const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : 0;
  notes.push(gap < 0.15 ? 'Close scores' : `Score gap ${gap.toFixed(2)}`);
  const leaders = ranked.slice(0, 2);
  const samples = leaders.map((r) => {
    const roundRow = roundStatsAvailable(input.analytics)
      ? input.analytics.round_item_stats?.find((s) => s.item_id === r.item.id && s.round === round)
      : undefined;
    const row = validCounts(roundRow) ? roundRow : input.analytics.item_stats.find((s) => s.item_id === r.item.id);
    return validCounts(row) ? row.matches : 0;
  });
  if (samples.some((n) => n < 200) || leaders.some((r) => !r.known)) notes.push('limited item samples');
  if (!validCounts(input.analytics.hero_stats)) notes.push('neutral hero baseline');
  const window = input.analytics.stats_window;
  if (!window) notes.push('legacy stats window');
  else if (window.role !== 'primary' || window.catalog_compatibility !== 'current')
    notes.push('unverified stats window');
  const allRound =
    roundStatsAvailable(input.analytics) &&
    leaders.every((r) =>
      validCounts(input.analytics.round_item_stats?.find((s) => s.item_id === r.item.id && s.round === round)),
    );
  notes.push(allRound ? 'purchase-round / match-win stats' : 'match-wide stats');
  if (reroll?.distributionStatus === 'empirical-approximation') notes.push('experimental reroll estimate');
  else notes.push('uniform reroll approximation');
  return `Evidence: ${notes.join(' · ')}`;
}
