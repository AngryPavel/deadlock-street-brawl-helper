import { describe, expect, it } from 'vitest';
import { SelfHeroConfirmation } from '../selfHeroConfirmation';
const paige = { heroId: 67, side: 'left', slot: 0 } as const;
const graves = { heroId: 76, side: 'left', slot: 2 } as const;
describe('fresh player identity confirmation', () => {
  it('rejects the first wrong read and cached repeats, then confirms two fresh Graves reads', () => {
    const c = new SelfHeroConfirmation();
    c.observe(paige, 1, 0);
    c.observe(paige, 1, 50);
    expect(c.value).toBeNull();
    c.observe(graves, 2, 500);
    expect(c.value).toBeNull();
    expect(c.observe(graves, 3, 1000)).toBe(true);
    expect(c.value).toEqual(graves);
    c.observe(paige, 4, 6000);
    c.observe(null, 5, 6500);
    expect(c.value).toEqual(graves);
  });
  it('requires consistent side and slot, corrects an established identity, and resets for a new game', () => {
    const c = new SelfHeroConfirmation();
    c.observe(paige, 1, 0);
    c.observe(paige, 2, 500);
    c.observe(graves, 3, 5500);
    c.observe({ ...graves, side: 'right' }, 4, 6000);
    expect(c.value).toEqual(paige);
    c.observe(graves, 5, 6500);
    c.observe(graves, 6, 7000);
    expect(c.value).toEqual(graves);
    expect(c.due(11_999)).toBe(false);
    expect(c.due(12_000)).toBe(true);
    c.reset();
    expect(c.value).toBeNull();
    expect(c.due(0)).toBe(true);
  });
});
