// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamHeroWinRatePanel } from '../../local/TeamHeroWinRatePanel';

afterEach(cleanup);
const edge = { ownWinRate: 0.53, enemyWinRate: 0.51, deltaPp: 2, window: '2026-09-01 – 2026-09-30' };

describe('TeamHeroWinRatePanel', () => {
  it('shows both four-hero means and the signed percentage-point proxy with its source window', () => {
    const { container } = render(<TeamHeroWinRatePanel draft round={1} edge={edge} />);
    expect(container.textContent).toContain('Average hero WR · 4 vs 4');
    expect(container.textContent).toContain('Ours 53.0%');
    expect(container.textContent).toContain('Enemy 51.0%');
    expect(container.textContent).toContain('+2.0 pp');
    expect(container.textContent).toContain('composition proxy');
    expect(container.textContent).toContain(edge.window);
    expect(container.querySelector('[data-direction="positive"]')).not.toBeNull();
  });

  it('disappears for later rounds, outside the draft, and when roster or statistics are incomplete', () => {
    const { container, rerender } = render(<TeamHeroWinRatePanel draft round={1} edge={edge} />);
    for (const props of [
      { draft: true, round: 2, edge },
      { draft: false, round: 1, edge },
      { draft: true, round: 1, edge: null },
      { draft: true, round: 1, edge: { ...edge, ownWinRate: NaN } },
      { draft: true, round: 1, edge: { ...edge, enemyWinRate: 1.1 } },
    ]) {
      rerender(<TeamHeroWinRatePanel {...props} />);
      expect(container.childElementCount).toBe(0);
    }
  });

  it('keeps negative and tied edges legible without labeling them as a match win probability', () => {
    const { container, rerender } = render(<TeamHeroWinRatePanel draft round={1} edge={{ ...edge, deltaPp: -2 }} />);
    expect(container.textContent).toContain('-2.0 pp');
    expect(container.querySelector('[data-direction="negative"]')).not.toBeNull();
    rerender(<TeamHeroWinRatePanel draft round={1} edge={{ ...edge, deltaPp: -0.00001 }} />);
    expect(container.textContent).toContain('0.0 pp');
    expect(container.textContent).not.toContain('-0.0');
    expect(container.querySelector('[data-direction="neutral"]')).not.toBeNull();
  });
});
