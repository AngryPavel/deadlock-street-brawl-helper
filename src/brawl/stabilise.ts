// Smooths the per-frame card reads before they reach the overlay: a card's circle stays put while the matcher's
// position wobbles by a pixel or two, and a card that goes unreadable for a few frames (animation, a hover glow,
// a dropped frame) keeps being drawn instead of blinking out. Pure; the caller keeps the returned state.
import type { CardRead } from './recognise';

/** Frames a card may go unread before it is dropped (~0.4 s at the 15 fps draft rate). */
export const HOLD_FRAMES = 6;
/** Position/size change, as a share of the icon edge, that counts as noise and is ignored. */
export const DEADBAND = 0.06;
/** Change past this share of the edge is a real move: adopted at once. In between, it is eased in. */
export const JUMP = 0.3;

export interface StableState {
  reads: CardRead[];
  missed: number[];
}
export const emptyStable = (): StableState => ({ reads: [], missed: [] });

export function stabilise(prev: StableState, next: CardRead[]): StableState {
  const reads: CardRead[] = [];
  const missed: number[] = [];
  next.forEach((n, i) => {
    const p = prev.reads[i];
    if (n.present) {
      if (p?.present && p.itemId === n.itemId) {
        const e = n.match.edge;
        const d = Math.max(
          Math.abs(n.match.x - p.match.x),
          Math.abs(n.match.y - p.match.y),
          Math.abs(n.match.edge - p.match.edge),
        );
        let match = p.match;
        if (d > JUMP * e) match = n.match;
        else if (d > DEADBAND * e)
          match = {
            ...n.match,
            x: (p.match.x + n.match.x) / 2,
            y: (p.match.y + n.match.y) / 2,
            edge: (p.match.edge + n.match.edge) / 2,
          };
        reads.push({ ...n, match });
      } else reads.push(n);
      missed.push(0);
    } else if (p?.present && (prev.missed[i] ?? 0) < HOLD_FRAMES) {
      reads.push(p);
      missed.push((prev.missed[i] ?? 0) + 1);
    } else {
      reads.push(n);
      missed.push(0);
    }
  });
  return { reads, missed };
}
