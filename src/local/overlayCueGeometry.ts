import type { DrawnRect, OverlayState } from '../brawl/draw';
import { availableReroll } from './overlaySettings';
import { cardSlotSelection } from './cardSlotSelection';

/** Enforce the action at the rendering boundary as well as in capture state. */
export function overlayDraftAction(state: OverlayState): { bestId: number | null; reroll: boolean } {
  if (!state.draft) return { bestId: null, reroll: false };
  const reroll = availableReroll(state.reroll ? true : null, state.advice?.rerollsRemaining) === true;
  if (reroll) return { bestId: null, reroll: true };
  const present = new Set(state.reads.filter((read) => read.present).map((read) => read.itemId));
  const bestId =
    state.bestId ??
    (state.reroll ? state.advice?.ranked.find((card) => present.has(card.itemId))?.itemId : null) ??
    null;
  const slot = cardSlotSelection(state.reads, bestId, state.advice).bestIndex;
  return { bestId: slot !== null ? state.reads[slot]!.itemId : null, reroll: false };
}

export interface ActionCueLayout {
  action: 'take' | 'reroll';
  itemId: number | null;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Use the canvas's actual rectangles, converting frame pixels directly to overlay CSS pixels.
 * Electron window dimensions are DIP/CSS pixels, so devicePixelRatio must not be applied again.
 * Independent axes also keep a captured ultrawide frame aligned with its overlay viewport. */
export function overlayActionCueLayout(
  drawn: DrawnRect[],
  frameW: number,
  frameH: number,
  viewportW: number,
  viewportH: number,
): ActionCueLayout | null {
  if (![frameW, frameH, viewportW, viewportH].every((n) => Number.isFinite(n) && n > 0)) return null;
  const target = drawn.find((rect) => rect.kind === 'reroll') ?? drawn.find((rect) => rect.kind === 'best');
  if (!target) return null;
  const rect = target.kind === 'best' ? target.plate : target;
  if (!rect || ![rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite) || rect.x1 <= rect.x0 || rect.y1 <= rect.y0)
    return null;
  const sx = viewportW / frameW;
  const sy = viewportH / frameH;
  return {
    action: target.kind === 'reroll' ? 'reroll' : 'take',
    itemId: target.itemId,
    left: rect.x0 * sx,
    top: rect.y0 * sy,
    width: (rect.x1 - rect.x0) * sx,
    height: (rect.y1 - rect.y0) * sy,
  };
}
