export interface OfferIdentity {
  key: string;
  round: number;
  choice: number;
}

/** Recognition consensus proposes a tuple; it does not by itself permit replacing a committed offer. */
export class DraftOfferLock {
  current: OfferIdentity | null = null;
  private candidate = '';
  private hits = 0;
  private since = 0;
  private reroll = false;
  get awaitingReroll() {
    return this.reroll;
  }
  reset() {
    this.current = null;
    this.candidate = '';
    this.hits = 0;
    this.reroll = false;
  }
  armReroll() {
    this.reroll = true;
    this.candidate = '';
    this.hits = 0;
  }
  observe(proposed: OfferIdentity, now: number, inventoryPick = false): boolean {
    if (!proposed.key || !proposed.choice) {
      this.candidate = '';
      this.hits = 0;
      return false;
    }
    const current = this.current;
    const round =
      proposed.round ||
      (current && proposed.choice === 1 && current.choice > 1 ? Math.min(5, current.round + 1) : (current?.round ?? 0));
    const next = { ...proposed, round };
    const establishRound = !!current && current.round === 0 && proposed.round > 0;
    const sameLabels = !!current && (next.round === current.round || establishRound) && next.choice === current.choice;
    if (current && sameLabels && next.key === current.key && !this.reroll && !establishRound) {
      this.candidate = '';
      this.hits = 0;
      return false;
    }
    const forward =
      !!current &&
      ((next.round === current.round && next.choice > current.choice) ||
        (next.round === current.round + 1 && next.choice === 1) ||
        (establishRound && (next.choice >= current.choice || next.choice === 1)));
    if (current && !forward && !(this.reroll && sameLabels)) {
      this.candidate = '';
      this.hits = 0;
      return false;
    }
    const candidate = `${next.round}:${next.choice}:${next.key}`;
    if (candidate === this.candidate) this.hits++;
    else {
      this.candidate = candidate;
      this.hits = 1;
      this.since = now;
    }
    // Identical-card label advances need extra corroboration when inventory cannot prove a selection.
    const identicalAdvance = forward && next.choice !== current!.choice && next.key === current!.key && !inventoryPick;
    if (this.hits < (identicalAdvance ? 3 : 2) || (identicalAdvance && now - this.since < 500)) return false;
    this.current = next;
    this.candidate = '';
    this.hits = 0;
    this.reroll = false;
    return true;
  }
}
