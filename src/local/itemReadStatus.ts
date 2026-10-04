import type { CardNameOutcome } from './cardNameConfirmation';

/** Progress carries no tentative item IDs into the interface or advice. */
export interface ItemReadStatus {
  confirmed: number;
  phase: 'reading' | 'unknown' | 'unavailable' | 'settling';
  unresolved: number[];
}

export function readingItemStatus(direct: readonly boolean[]): ItemReadStatus {
  return {
    confirmed: direct.filter(Boolean).length,
    phase: 'reading',
    unresolved: [0, 1, 2].filter((slot) => !direct[slot]),
  };
}

export function completedItemStatus(outcome: CardNameOutcome): ItemReadStatus {
  const unresolved = outcome.slots.filter((slot) => slot.status === 'unknown' || slot.status === 'unavailable');
  return {
    confirmed: outcome.slots.length - unresolved.length,
    phase: unresolved.some((slot) => slot.status === 'unavailable')
      ? 'unavailable'
      : unresolved.length
        ? 'unknown'
        : 'settling',
    unresolved: unresolved.map((slot) => slot.slot),
  };
}

export function itemReadStatusText(status: ItemReadStatus): string {
  const progress = `${status.confirmed}/3`;
  if (status.phase === 'reading') return `Draft — reading items (${progress})…`;
  if (status.phase === 'settling') return 'Draft — confirming items (3/3)…';
  if (status.phase === 'unavailable') return `Draft — item reader unavailable (${progress}); retrying`;
  const slots = status.unresolved
    .map((slot) => ['left', 'top', 'right'][slot])
    .filter(Boolean)
    .join(', ');
  return `Draft — ${slots || 'item'} name unread (${progress}); reveal the names or press F8`;
}
