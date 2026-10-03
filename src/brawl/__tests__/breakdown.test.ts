import { describe, expect, it } from 'vitest';
import { breakdownRows, NO_DATA_LABEL } from '../breakdown';
import type { ScoreParts } from '../types';

const zero: ScoreParts = {
  pop: 0,
  winLift: 0,
  kit: 0,
  tier: 0,
  counter: 0,
  synergy: 0,
  active: 0,
  upgrade: 0,
  enhanced: 0,
  dup: 0,
};

describe('breakdownRows', () => {
  it('rows sum to the rounded score and skip zero parts', () => {
    const parts = { ...zero, pop: 0.333, winLift: 0.333, kit: 0.334, dup: -0.0004, tier: 0.5 };
    const score = Object.values(parts).reduce((a, x) => a + x, 0);
    const rows = breakdownRows(parts, score, true);
    expect(rows.some((r) => r.label === 'Duplicate')).toBe(false);
    expect(rows.reduce((a, r) => a + r.cents, 0)).toBe(Math.round(score * 100));
  });
  it('shows a single row for an item without data', () => {
    expect(breakdownRows(zero, 1, false)).toEqual([{ label: NO_DATA_LABEL, cents: 0 }]);
  });
  it('uses only fixed labels', () => {
    const rows = breakdownRows({ ...zero, pop: 1, counter: -1, synergy: 0.5 }, 0.5, true);
    expect(rows.map((r) => r.label)).toEqual(['Pick rate', 'Vs enemy team', 'With your items']);
  });
});
