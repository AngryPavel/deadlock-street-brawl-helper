// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScoreTip } from '../ScoreTip';
import { breakdownRows } from '../../brawl/breakdown';
import type { OverlayAdviceCard } from '../../brawl/draw';
import type { ScoreParts } from '../../brawl/types';

const parts: ScoreParts = {
  pop: 0.412,
  winLift: 0.2049,
  kit: 0.1,
  tier: 0.5,
  counter: -0.0733,
  synergy: 0,
  active: 0,
  upgrade: 0,
  enhanced: 0,
  dup: -0.3,
};
const score = Object.values(parts).reduce((a, x) => a + x, 0);
const card = (known: boolean): OverlayAdviceCard => ({
  itemId: 1,
  name: 'Extra Regen',
  score,
  enhanced: false,
  usage: 0.5,
  winRate: 0.5,
  grade: 'A',
  rows: breakdownRows(parts, score, known),
});

describe('ScoreTip', () => {
  it('lists name and tier, fixed labels with signed numbers, and rows that add up to the score', () => {
    const { container } = render(<ScoreTip card={card(true)} />);
    expect(screen.getByText('Extra Regen · A')).toBeTruthy();
    const nums = [...container.querySelectorAll('.tip-row:not(.tip-total) b')].map((e) =>
      Number(e.textContent!.replace('−', '-')),
    );
    const total = Number(container.querySelector('.tip-total b')!.textContent);
    expect(total).toBe(Number(score.toFixed(2)));
    expect(Math.round(nums.reduce((a, n) => a + n, 0) * 100)).toBe(Math.round(total * 100));
    const labels = [...container.querySelectorAll('.tip-row span')].map((e) => e.textContent);
    expect(labels).toEqual(['Win rate', 'Pick rate', 'Hero fit', 'Vs enemy team', 'Item tier', 'Duplicate', 'Score']);
  });
  it('shows the single "No Street Brawl data" row for an item without data', () => {
    const { container } = render(<ScoreTip card={card(false)} />);
    expect([...container.querySelectorAll('.tip-row')].map((e) => e.textContent)).toEqual(['No Street Brawl data']);
  });
});
