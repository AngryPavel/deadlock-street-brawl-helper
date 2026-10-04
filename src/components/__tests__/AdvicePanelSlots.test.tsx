// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AdvicePanel } from '../AdvicePanel';
import { adviseDraft } from '../../brawl/engine';
import { heroByName, inputFor, itemByName } from '../../brawl/__tests__/testData';

afterEach(cleanup);
it('keeps exactly the current three ranked slots through duplicate-item draft transitions', () => {
  const input = inputFor(heroByName('Infernus').id);
  const old = itemByName('Titanic Magazine').id;
  const current = ['Swift Striker', 'Quicksilver Reload', 'Spirit Shielding'].map((name) => itemByName(name).id);
  const make = (ids: number[]) => {
    const cards = ids.map((itemId) => ({ itemId }));
    const ranked = adviseDraft(input, {
      round: 1,
      choice: 2,
      rerollsRemaining: 0,
      owned: [],
      enemies: [],
      sets: [[], cards, []],
    }).sets[1];
    expect(ranked).toHaveLength(3);
    return {
      input,
      error: null,
      cards,
      capture: 'on' as const,
      status: '',
      lastTaken: '',
      owned: [],
      ranked,
      reroll: null,
      rerolls: 0,
      hero: input.hero,
      took: () => {},
      rerolled: () => {},
    };
  };
  const { container, rerender } = render(<AdvicePanel {...make([old, old, old])} />);
  for (const ids of [current, [old, old, old], [...current].reverse(), current]) {
    const props = make(ids);
    rerender(<AdvicePanel {...props} />);
    const rows = [...container.querySelectorAll('.brawl-card')];
    expect(rows).toHaveLength(3);
    rows.forEach((row, slot) => expect(row.textContent).toContain(props.ranked[slot]!.item.name));
    if (ids === current) expect(container.textContent).not.toContain('Titanic Magazine');
  }
});
