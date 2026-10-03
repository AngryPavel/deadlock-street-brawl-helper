import type { ScoreParts } from './types';

export interface BreakdownRow {
  label: string;
  /** Signed value in hundredths, so the rows add up exactly to the rounded score. */
  cents: number;
}

/** Fixed noun labels for the score parts, in display order. */
const LABELS: [keyof ScoreParts, string][] = [
  ['winLift', 'Win rate'],
  ['pop', 'Pick rate'],
  ['kit', 'Hero fit'],
  ['counter', 'Vs enemy team'],
  ['synergy', 'With your items'],
  ['tier', 'Item tier'],
  ['active', 'Active items'],
  ['upgrade', 'Upgrade'],
  ['enhanced', 'Enhanced'],
  ['dup', 'Duplicate'],
];

export const NO_DATA_LABEL = 'No Street Brawl data';

/** One row per score part that is not zero at two decimals. The rows sum to `Math.round(score * 100)` exactly: the
 *  rounding remainder goes to the largest row, so the tooltip always adds up to the `Score: <n>` on the plate. */
export function breakdownRows(parts: ScoreParts, score: number, known: boolean): BreakdownRow[] {
  if (!known) return [{ label: NO_DATA_LABEL, cents: 0 }];
  const rows = LABELS.map(([key, label]) => ({ label, cents: Math.round(parts[key] * 100) })).filter(
    (r) => r.cents !== 0,
  );
  const diff = Math.round(score * 100) - rows.reduce((a, r) => a + r.cents, 0);
  if (diff !== 0 && rows.length) {
    const big = rows.reduce((a, r) => (Math.abs(r.cents) > Math.abs(a.cents) ? r : a));
    big.cents += diff;
  }
  return rows.filter((r) => r.cents !== 0);
}

export const formatSigned = (cents: number) =>
  `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${(Math.abs(cents) / 100).toFixed(2)}`;
