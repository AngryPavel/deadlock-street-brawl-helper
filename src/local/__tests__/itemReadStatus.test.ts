import { expect, it } from 'vitest';
import { completedItemStatus, itemReadStatusText, readingItemStatus } from '../itemReadStatus';

it('explains which slot blocks advice and separates a completed unread name from a service retry', () => {
  const base = {
    candidate: '4:3:1',
    evidenceKey: 'pixels',
    slots: [
      { slot: 0, status: 'strong' as const, itemId: 1 },
      { slot: 1, status: 'unknown' as const, itemId: 0 },
      { slot: 2, status: 'exact' as const, itemId: 3 },
    ],
  };
  const unknown = completedItemStatus(base);
  expect(unknown).toEqual({ confirmed: 2, phase: 'unknown', unresolved: [1] });
  expect(itemReadStatusText(unknown)).toBe('Draft — top name unread (2/3); reveal the names or press F8');
  expect(itemReadStatusText(readingItemStatus([true, false, true]))).toBe('Draft — reading items (2/3)…');
  const unavailable = completedItemStatus({
    ...base,
    slots: base.slots.map((slot) => (slot.status === 'unknown' ? { ...slot, status: 'unavailable' as const } : slot)),
  });
  expect(itemReadStatusText(unavailable)).toBe('Draft — item reader unavailable (2/3); retrying');
  expect(
    itemReadStatusText(
      completedItemStatus({
        ...base,
        slots: base.slots.map((slot) => ({ ...slot, status: 'strong' as const })),
      }),
    ),
  ).toBe('Draft — confirming items (3/3)…');
});
