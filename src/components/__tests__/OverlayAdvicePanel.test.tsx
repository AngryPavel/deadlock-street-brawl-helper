// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OverlayAdvicePanel } from '../../local/OverlayAdvicePanel';
import { availableReroll } from '../../local/overlaySettings';
import { adviseDraft, baseScores, roundTiers } from '../../brawl/engine';
import { heroByName, inputFor } from '../../brawl/__tests__/testData';
import type { OverlayAdvice } from '../../brawl/draw';

afterEach(cleanup);
const input = inputFor(heroByName('Infernus').id);
const weakest = [...baseScores(input).values()]
  .filter((b) => b.item.item_tier === roundTiers(input, 2)[0].normal)
  .sort((a, b) => a.base - b.base)
  .slice(0, 3)
  .map((b) => ({ itemId: b.item.id }));
const draft = adviseDraft(input, { round: 2, owned: [], enemies: [], sets: [weakest, [], []] });
const advice: OverlayAdvice = {
  hero: 'Infernus',
  round: 2,
  choice: 1,
  rerollsRemaining: 1,
  reroll: availableReroll(draft.reroll, 1),
  ranked: draft.sets[0].map((r) => ({
    itemId: r.item.id,
    name: r.item.name,
    score: r.score,
    enhanced: r.enhanced,
    usage: r.usage,
    winRate: r.winRate,
    grade: '-',
    rows: [],
  })),
  status: 'Identified all three items',
  confidence: 'Evidence: Close scores · uniform reroll approximation',
};

describe('live overlay advice', () => {
  it('replaces every row when duplicate slots transition to the next actual three-card offer', () => {
    const old = advice.ranked[0]!;
    const duplicate = { ...old, itemId: 7, name: 'Titanic Magazine' };
    const { container, rerender } = render(
      <OverlayAdvicePanel advice={{ ...advice, reroll: null, ranked: [duplicate, duplicate, duplicate] }} />,
    );
    const next = [
      { ...old, itemId: 8, name: 'Swift Striker' },
      { ...old, itemId: 9, name: 'Quicksilver Reload' },
      { ...old, itemId: 10, name: 'Spirit Shielding' },
    ];
    for (const ranked of [next, [duplicate, duplicate, duplicate], [...next].reverse(), next]) {
      rerender(<OverlayAdvicePanel advice={{ ...advice, reroll: null, ranked }} />);
      const rows = [...container.querySelectorAll('.overlay-panel-card')];
      expect(rows).toHaveLength(3);
      rows.forEach((row, slot) => {
        expect(row.textContent).toContain(ranked[slot]!.name);
        expect(row.textContent).toContain(slot === 0 ? 'TAKE' : `#${slot + 1}`);
      });
      if (ranked === next) expect(container.textContent).not.toContain('Titanic Magazine');
    }
  });
  it('shows a real engine reroll recommendation with a confirmed available count and all item statistics', () => {
    expect(draft.reroll).not.toBeNull();
    const { container } = render(<OverlayAdvicePanel advice={advice} />);
    expect(container.textContent).toContain('RE-ROLL');
    expect(container.textContent).toContain('Re-rolls: 1');
    expect(container.textContent).toContain('Infernus · round 2, choice 1');
    expect(container.querySelectorAll('.overlay-panel-card').length).toBe(3);
    for (const r of advice.ranked) {
      expect(container.textContent).toContain(r.name);
      expect(container.textContent).toContain(r.score.toFixed(2));
    }
    expect(container.textContent).toContain('% picks');
    expect(container.textContent).toContain('% wins');
    expect(container.textContent).toContain(advice.status);
    expect(container.textContent).toContain(advice.confidence);
  });
  it('never offers a reroll with zero or an unknown count; compact mode retains the action and counter', () => {
    for (const count of [0, -1, null, undefined]) {
      expect(availableReroll(draft.reroll, count)).toBeNull();
      const { container, unmount } = render(
        <OverlayAdvicePanel advice={{ ...advice, rerollsRemaining: count, detail: 'compact' }} />,
      );
      expect(container.textContent).not.toContain('RE-ROLL');
      expect(container.textContent).toContain('TAKE');
      expect(container.querySelector('.local-reroll-counter')).not.toBeNull();
      expect(container.querySelector('.overlay-panel-card')).toBeNull();
      expect(container.textContent).not.toContain('uniform reroll approximation');
      unmount();
    }
  });
});
