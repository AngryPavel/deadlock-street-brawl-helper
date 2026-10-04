import { describe, expect, it } from 'vitest';
import { DraftOfferLock } from '../draftOfferLock';
const initial = { key: '1,2,3', round: 3, choice: 2 };
const locked = () => {
  const lock = new DraftOfferLock();
  lock.observe(initial, 0);
  lock.observe(initial, 100);
  return lock;
};
describe('committed draft transitions', () => {
  it('retains a committed offer through foreign stable cards, missing cards, backward labels and isolated forward labels', () => {
    const lock = locked();
    for (let time = 0; time < 1000; time += 100) expect(lock.observe({ ...initial, key: '9,9,9' }, time)).toBe(false);
    expect(lock.observe({ ...initial, key: '' }, 2000)).toBe(false);
    expect(lock.observe({ ...initial, round: 1 }, 2100)).toBe(false);
    expect(lock.observe({ ...initial, choice: 3, key: '4,5,6' }, 2200)).toBe(false);
    expect(lock.observe(initial, 2300)).toBe(false);
    expect(lock.current).toEqual(initial);
  });
  it('commits a legal complete next choice atomically without requiring inventory, and then a real next round', () => {
    const lock = locked();
    const next = { ...initial, choice: 3, key: '4,5,6' };
    expect(lock.observe(next, 200)).toBe(false);
    expect(lock.observe(next, 300)).toBe(true);
    const round = { key: '7,8,9', round: 4, choice: 1 };
    expect(lock.observe(round, 400)).toBe(false);
    expect(lock.observe(round, 500)).toBe(true);
    expect(lock.current).toEqual(round);
  });
  it('requires fresh post-decrement reads for rerolls with exactly the same IDs', () => {
    const lock = locked();
    lock.armReroll();
    expect(lock.observe(initial, 200)).toBe(false);
    expect(lock.observe(initial, 300)).toBe(true);
    expect(lock.awaitingReroll).toBe(false);
  });
  it('requires extra stable time for identical-card forward labels when the pick is unreadable', () => {
    const lock = locked();
    const next = { ...initial, choice: 3 };
    expect(lock.observe(next, 200)).toBe(false);
    expect(lock.observe(next, 300)).toBe(false);
    expect(lock.observe(next, 700)).toBe(true);
  });
  it.each([2, 3])('establishes an unread round when attached at choice2, then known round3 choice%s', (choice) => {
    const lock = new DraftOfferLock();
    const unknown = { ...initial, round: 0 };
    lock.observe(unknown, 0);
    lock.observe(unknown, 100);
    const known = { ...initial, choice, key: choice === 2 ? initial.key : '4,5,6' };
    expect(lock.observe(known, 200)).toBe(false);
    expect(lock.observe(known, 300)).toBe(true);
    expect(lock.current).toEqual(known);
  });
});
