export interface OfferIdentity {
  key: string;
  round: number;
  choice: number;
}
export interface OfferEvidence {
  frame?: number;
  labelsOnly?: boolean;
  /** Changes only when the three independently sampled icon cores change. */
  visual?: number;
  /** All three direct icon matches are strong; recovered OCR is not this evidence. */
  direct?: boolean;
  changedSlots?: number;
}
type Reason = 'choice' | 'round' | 'reroll' | 'reacquire';
/** Labels authorize a new generation; card animation must settle independently. */
export class DraftOfferLock {
  current: OfferIdentity | null = null;
  private candidate = '';
  private hits = 0;
  private since = 0;
  private label = '';
  private labelHits = 0;
  private labelSince = 0;
  private phase: { round: number; choice: number; since: number; reason: Reason } | null = null;
  private correctionUntil = -Infinity;
  private spent = false;
  private labelFrame = -Infinity;
  private restore = false;
  transition: Reason | 'initial' | 'metadata' | null = null;
  get awaitingReroll() {
    return this.spent;
  }
  get settling() {
    return !!this.phase;
  }
  get pendingLabels() {
    return this.phase;
  }
  get needsRestore() {
    return this.restore;
  }
  reset() {
    this.current = null;
    this.phase = null;
    this.spent = false;
    this.correctionUntil = -Infinity;
    this.clearCandidate();
    this.label = '';
    this.labelHits = 0;
    this.transition = null;
    this.restore = false;
    this.labelFrame = -Infinity;
  }
  private clearCandidate() {
    this.candidate = '';
    this.hits = 0;
  }
  armReroll() {
    this.spent = true;
    if (this.phase) this.phase.reason = 'reroll';
    else if (this.current) this.phase = { ...this.current, since: -1, reason: 'reroll' };
    this.clearCandidate();
  }
  observe(proposed: OfferIdentity, now: number, _inventoryPick = false, evidence: OfferEvidence = {}): boolean {
    this.transition = null;
    const current = this.current;
    if (!proposed.choice) {
      this.clearCandidate();
      return false;
    }
    const round =
      proposed.round ||
      (current && proposed.choice === 1 && current.choice > 1 ? Math.min(5, current.round + 1) : (current?.round ?? 0));
    const next = { ...proposed, round };
    const sameLabels = !!current && next.round === current.round && next.choice === current.choice;
    const establishRound = !!current && current.round === 0 && proposed.round > 0 && next.choice === current.choice;
    const forward =
      !!current &&
      ((next.round === current.round && next.choice > current.choice) ||
        (next.round === current.round + 1 && next.choice === 1) ||
        (current.round === 0 && proposed.round > 0 && next.choice > current.choice));
    if (this.phase && this.phase.reason !== 'reacquire' && this.phase.reason !== 'reroll' && sameLabels) {
      this.phase = null;
      this.clearCandidate();
      this.label = '';
      this.labelHits = 0;
      this.restore = true;
      if (next.key === current!.key) {
        this.restore = false;
        this.transition = 'metadata';
        return true;
      }
    }
    if (!this.phase && current && !establishRound) {
      if (sameLabels && next.key === current.key) {
        this.clearCandidate();
        this.label = '';
        this.labelHits = 0;
        if (this.restore) {
          this.restore = false;
          this.transition = 'metadata';
          return true;
        }
        return false;
      }
      if (sameLabels) {
        const correction =
          evidence.direct &&
          ((now <= this.correctionUntil && (evidence.changedSlots ?? 0) > 0) || evidence.changedSlots === 3);
        if (!correction) {
          this.clearCandidate();
          return false;
        }
        this.phase = { round, choice: next.choice, since: now, reason: 'reacquire' };
        this.clearCandidate();
      } else if (forward) {
        const label = `${round}:${next.choice}`;
        if (label === this.label && this.labelFrame !== (evidence.frame ?? now)) this.labelHits++;
        else if (label !== this.label) {
          this.label = label;
          this.labelHits = 1;
          this.labelSince = now;
        }
        this.labelFrame = evidence.frame ?? now;
        if (this.labelHits < 2) {
          this.clearCandidate();
          return false;
        }
        this.phase = {
          round,
          choice: next.choice,
          since: this.labelSince,
          reason: round !== current.round ? 'round' : 'choice',
        };
        this.clearCandidate();
      } else {
        this.clearCandidate();
        this.label = '';
        this.labelHits = 0;
        return false;
      }
    }
    if (this.phase && (round !== this.phase.round || next.choice !== this.phase.choice)) {
      this.clearCandidate();
      return false;
    }
    if (!next.key) {
      if (!evidence.labelsOnly) this.clearCandidate();
      return false;
    }
    if (this.phase?.since === -1) this.phase.since = now;
    const candidate = `${round}:${next.choice}:${next.key}:${evidence.visual ?? 0}`;
    if (candidate === this.candidate) this.hits++;
    else {
      this.candidate = candidate;
      this.hits = 1;
      this.since = now;
    }
    const phase = this.phase;
    if (phase) {
      const unchangedPrior =
        phase.reason !== 'reroll' &&
        phase.reason !== 'reacquire' &&
        next.key === current?.key &&
        !(evidence.changedSlots ?? 0);
      const age = now - phase.since;
      if (
        this.hits < 3 ||
        now - this.since < 300 ||
        age < (unchangedPrior ? 1500 : phase.reason === 'reacquire' ? 300 : 500)
      )
        return false;
    } else if (this.hits < 3 || now - this.since < 500) return false;
    this.current = next;
    this.transition = phase?.reason ?? (current ? 'metadata' : 'initial');
    if (phase && phase.reason !== 'reacquire') this.correctionUntil = phase.since + 1500;
    else if (!current) this.correctionUntil = this.since + 1500;
    this.phase = null;
    this.spent = false;
    this.clearCandidate();
    this.label = '';
    this.labelHits = 0;
    return true;
  }
}
