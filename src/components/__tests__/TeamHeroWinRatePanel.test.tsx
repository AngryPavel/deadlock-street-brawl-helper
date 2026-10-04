// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamHeroWinRatePanel } from '../../local/TeamHeroWinRatePanel';
import type { TeamWinRateEdge } from '../../local/teamWinRate';
import { readFileSync } from 'node:fs';

const styles = readFileSync('src/local/TeamHeroWinRatePanel.css', 'utf8');

afterEach(cleanup);
const heroNames = ['Abrams', 'Bebop', 'Dynamo', 'Grey Talon', 'Haze', 'Infernus', 'Ivy', 'Kelvin'];
const rates = [0.61, 0.59, 0.49, 0.43, 0.57, 0.51, 0.5, 0.46];
const heroRows = heroNames.map((name, i) => ({ heroId: i + 1, name, winRate: rates[i] }));
const edge: TeamWinRateEdge = {
  ownHeroes: heroRows.slice(0, 4),
  enemyHeroes: heroRows.slice(4),
  ownWinRate: 0.53,
  enemyWinRate: 0.51,
  deltaPp: 2,
  window: '2026-09-01 – 2026-09-30',
};

const styledPanel = (value: TeamWinRateEdge) => (
  <>
    <style>{styles}</style>
    <TeamHeroWinRatePanel draft round={1} edge={value} />
  </>
);

describe('TeamHeroWinRatePanel', () => {
  it('shows an explicitly confirmed preparation phase without draft advice, and hides immediately when disabled', () => {
    const { container, rerender } = render(<TeamHeroWinRatePanel visible draft={false} edge={edge} />);
    expect(screen.getByRole('complementary', { name: 'Team average hero win rates' })).toBeTruthy();
    rerender(<TeamHeroWinRatePanel visible={false} draft round={1} edge={edge} />);
    expect(container.childElementCount).toBe(0);
  });
  it('shows every hero and individual Street Brawl rate under the correct team, both means, difference and source', () => {
    const { container } = render(<TeamHeroWinRatePanel draft round={1} edge={edge} />);
    expect(container.textContent).toContain('Street Brawl · Hero win rates');
    const ownList = screen.getByRole('list', { name: 'Ours hero win rates' });
    const enemyList = screen.getByRole('list', { name: 'Enemy hero win rates' });
    const rows = [...within(ownList).getAllByRole('listitem'), ...within(enemyList).getAllByRole('listitem')];
    expect(rows).toHaveLength(8);
    rows.forEach((row, i) => {
      expect(row.textContent).toBe(`${heroNames[i]}${(rates[i] * 100).toFixed(1)}%`);
    });
    expect(screen.getByRole('region', { name: 'Ours' }).textContent).toContain('Ours avg53.0%');
    expect(screen.getByRole('region', { name: 'Enemy' }).textContent).toContain('Enemy avg51.0%');
    expect(container.textContent).toContain('Difference+2.0 pp');
    expect(container.textContent).toContain('composition proxy');
    expect(container.textContent).toContain(edge.window);
  });

  it('preserves own and enemy names, rates and averages when the player is on the right team', () => {
    render(
      <TeamHeroWinRatePanel
        draft
        round={1}
        edge={{
          ...edge,
          ownHeroes: edge.enemyHeroes,
          enemyHeroes: edge.ownHeroes,
          ownWinRate: edge.enemyWinRate,
          enemyWinRate: edge.ownWinRate,
          deltaPp: -2,
        }}
      />,
    );
    const own = screen.getByRole('region', { name: 'Ours' });
    const enemy = screen.getByRole('region', { name: 'Enemy' });
    expect(own.textContent).toContain('Ours avg51.0%');
    expect(own.textContent).toContain('Haze57.0%');
    expect(own.textContent).not.toContain('Abrams');
    expect(enemy.textContent).toContain('Enemy avg53.0%');
    expect(enemy.textContent).toContain('Abrams61.0%');
  });

  it('disappears for later rounds, outside the draft and incomplete or invalid roster statistics', () => {
    const { container, rerender } = render(<TeamHeroWinRatePanel draft round={1} edge={edge} />);
    for (const props of [
      { draft: true, round: 2, edge },
      { draft: false, round: 1, edge },
      { draft: true, round: 1, edge: null },
      { draft: true, round: 1, edge: { ...edge, ownWinRate: NaN } },
      { draft: true, round: 1, edge: { ...edge, enemyWinRate: 1.1 } },
      { draft: true, round: 1, edge: { ...edge, ownHeroes: edge.ownHeroes.slice(0, 3) } },
      { draft: true, round: 1, edge: { ...edge, enemyHeroes: [] } },
      {
        draft: true,
        round: 1,
        edge: { ...edge, enemyHeroes: edge.enemyHeroes.map((h, i) => (i === 3 ? { ...h, winRate: NaN } : h)) },
      },
    ]) {
      rerender(<TeamHeroWinRatePanel {...props} />);
      expect(container.childElementCount).toBe(0);
    }
  });

  it('colors the whole panel green for an advantage, red for a disadvantage, and neutral only for an exact tie', () => {
    const { rerender } = render(styledPanel(edge));
    for (const [deltaPp, direction, border, background, text] of [
      [2, 'positive', 'rgb(82, 227, 139)', 'rgba(18, 48, 32, 0.92)', '+2.0 pp'],
      [-2, 'negative', 'rgb(240, 120, 120)', 'rgba(58, 24, 28, 0.92)', '−2.0 pp'],
      [-0.00001, 'negative', 'rgb(240, 120, 120)', 'rgba(58, 24, 28, 0.92)', '−<0.1 pp'],
      [0.00001, 'positive', 'rgb(82, 227, 139)', 'rgba(18, 48, 32, 0.92)', '+<0.1 pp'],
      [0, 'neutral', 'rgb(119, 124, 128)', undefined, '0.0 pp'],
    ] as const) {
      rerender(styledPanel({ ...edge, deltaPp }));
      const panel = screen.getByRole('complementary', { name: 'Team average hero win rates' });
      expect(panel.dataset.direction).toBe(direction);
      expect(panel.textContent).toContain(text);
      expect(getComputedStyle(panel).borderTopColor).toBe(border);
      if (background) expect(getComputedStyle(panel).backgroundColor).toBe(background);
      expect(panel.textContent).not.toContain('win probability');
    }
  });
});
