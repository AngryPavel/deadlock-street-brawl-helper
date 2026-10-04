import type { FrameResult } from '../brawl/worker';

/** Lock accepted cards across tooltips; only a new draft, spent reroll or closed shop invalidates them. */
export class DraftFrameGate {
  private stable: FrameResult | null = null;
  private missingSince: number | null = null;
  invalidate() {
    this.stable = null;
    this.missingSince = null;
  }
  acceptsContext(frame: FrameResult) {
    const previous = this.stable;
    return (
      !previous ||
      !!(frame.accepted && frame.transition) ||
      (frame.key === previous.key &&
        (frame.choice === 0 || frame.choice === previous.choice) &&
        (frame.round === 0 || previous.round === 0 || frame.round === previous.round))
    );
  }

  publish(frame: FrameResult, now: number): boolean {
    const previous = this.stable;
    const changedLabels =
      previous &&
      frame.shop &&
      ((frame.choice > 0 && frame.choice !== previous.choice) ||
        (frame.round > 0 && previous.round > 0 && frame.round !== previous.round));
    const changedItems = previous && frame.shop && frame.accepted && frame.key && frame.key !== previous.key;
    if (previous && frame.shop && !this.acceptsContext(frame)) return false;
    if (changedLabels || changedItems) {
      // The worker committed these labels/cards together after verifying the transition.
      this.invalidate();
    }
    if (frame.shop && frame.key) {
      if (this.stable && frame.key !== this.stable.key && !frame.accepted) return false;
      if (frame.accepted || (this.stable && frame.key === this.stable.key)) this.stable = frame;
      this.missingSince = null;
      return true;
    }
    if (this.stable) {
      if (frame.shop) {
        this.missingSince = null;
        return false; // A tooltip can obscure icons/names for seconds: keep the known choice.
      }
      this.missingSince ??= now;
      if (now - this.missingSince < 250) return false;
      this.invalidate();
    }
    // Within a single frame OCR can emit 2/3, immediately followed by 3/3. Never render that pulse.
    return !frame.pending || !!(changedLabels || changedItems);
  }
}
