import type { ActionCueLayout } from './overlayCueGeometry';
import './OverlayActionCue.css';

/** Transparent decoration only: the game keeps every click and its item/button text stays uncovered. */
export function OverlayActionCue({ cue }: { cue: ActionCueLayout | null }) {
  if (!cue) return null;
  const { left, top, width, height } = cue;
  return (
    <div
      key={`${cue.action}-${cue.itemId}`}
      className="overlay-action-cue"
      data-action={cue.action}
      data-item-id={cue.itemId ?? undefined}
      aria-hidden="true"
      style={{ left, top, width, height }}
    />
  );
}
