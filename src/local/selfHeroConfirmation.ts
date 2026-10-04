export interface SelfHeroObservation {
  heroId: number;
  side: 'left' | 'right';
  slot: number;
}

/** Only independent fresh marker/portrait observations may confirm or correct the player. */
export class SelfHeroConfirmation {
  value: SelfHeroObservation | null = null;
  private candidate = '';
  private hits = 0;
  private frame = -1;
  private nextRead = 0;
  reset() {
    this.value = null;
    this.candidate = '';
    this.hits = 0;
    this.frame = -1;
    this.nextRead = 0;
  }
  due(now: number) {
    return now >= this.nextRead;
  }
  observe(observation: SelfHeroObservation | null, frame: number, now: number) {
    if (frame === this.frame) return false;
    this.frame = frame;
    const key = observation?.heroId ? `${observation.side}:${observation.slot}:${observation.heroId}` : '';
    const current = this.value ? `${this.value.side}:${this.value.slot}:${this.value.heroId}` : '';
    this.nextRead = now + (key && key === current ? 5000 : 500);
    if (!key) {
      this.candidate = '';
      this.hits = 0;
      return false;
    }
    this.hits = key === this.candidate ? this.hits + 1 : 1;
    this.candidate = key;
    if (this.hits < 2 || key === current) return false;
    this.value = { ...observation! };
    this.nextRead = now + 5000;
    return true;
  }
}
