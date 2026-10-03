// The "upgrade this ability" tip: appears when the item draft screen closes, lasts ~15 s, then goes away for good
// until the next draft closes. Pure state machine (time is passed in) so it is unit-testable without a clock.

/** How long the tip stays up. */
export const TIP_MS = 15_000;
/** Consecutive non-draft frames before the draft counts as closed (the screen can blink between choices). */
export const CLOSE_FRAMES = 6;

export interface TipState<T> {
  draft: boolean; // the draft screen is (still) considered open
  missed: number; // consecutive non-draft frames while draft is true
  sawDraft: boolean; // a draft screen was seen since the last tip started (a tip needs a draft to close)
  tip: { value: T; endsAt: number } | null;
}

export const initialTip = <T>(): TipState<T> => ({ draft: false, missed: 0, sawDraft: false, tip: null });

/** Advances the tracker by one frame result (`shop`: the frame is the item draft screen) at time `now` (ms).
 *  `current` is the ability the advisor wants next *now* (latched when the draft closes); null: nothing to show.
 *  Call it with the last `shop` again from a timer to expire the tip without waiting for another frame. */
export function stepTip<T>(
  s: TipState<T>,
  shop: boolean,
  now: number,
  current: T | null,
  durationMs = TIP_MS,
): TipState<T> {
  let { draft, missed, sawDraft, tip } = s;
  if (shop) {
    draft = true;
    missed = 0;
    sawDraft = true;
    tip = null; // a draft screen reopening ends the tip at once
  } else if (draft) {
    missed += 1;
    if (missed >= CLOSE_FRAMES) {
      draft = false;
      missed = 0;
      if (sawDraft && current !== null) tip = { value: current, endsAt: now + durationMs };
      sawDraft = false;
    }
  }
  if (tip && now >= tip.endsAt) tip = null;
  if (draft === s.draft && missed === s.missed && sawDraft === s.sawDraft && tip === s.tip) return s;
  return { draft, missed, sawDraft, tip };
}
