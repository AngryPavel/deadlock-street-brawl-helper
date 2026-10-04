import type { Item } from '../types';

/** Session-only confirmed game state. Visible inventory is evidence of possession, never of loss. */
export class MatchMemory {
  private roster = '';
  private candidate = '';
  private hits = 0;
  private lastRound = 0;
  private pendingInventory: { ids: number[]; items: Item[]; now: number }[] = [];
  enemies: number[] = [];
  owned: number[] = [];
  acquisitions: { itemId: number; observedAt: number }[] = [];
  get rosterStable() {
    return this.hits >= 2;
  }
  reset() {
    this.roster = this.candidate = '';
    this.hits = this.lastRound = 0;
    this.pendingInventory = [];
    this.enemies = [];
    this.owned = [];
    this.acquisitions = [];
  }
  observeRoster(self: number, foes: number[], round: number, identityCorrection = false) {
    const sorted = [...new Set(foes.filter((id) => id > 0))].sort((a, b) => a - b);
    if (!self || sorted.length !== 4) {
      this.hits = 0;
      this.candidate = '';
      this.pendingInventory = [];
      return { changed: false, newMatch: false };
    }
    const roster = `${self}:${sorted.join(',')}`;
    const restart = this.lastRound > 1 && round === 1;
    // A confirmed player/side correction fixes our interpretation of this session, not its purchases.
    if (identityCorrection && this.roster && !restart) {
      const changed = roster !== this.roster;
      this.roster = roster;
      this.candidate = `${roster}:continue`;
      this.hits = 2;
      this.enemies = sorted;
      this.pendingInventory = [];
      if (round > 0) this.lastRound = round;
      return { changed, newMatch: false };
    }
    const candidate = `${roster}:${restart ? 'restart' : 'continue'}`;
    if (candidate !== this.candidate) this.pendingInventory = [];
    this.hits = candidate === this.candidate ? this.hits + 1 : 1;
    this.candidate = candidate;
    if (this.hits < 2) return { changed: false, newMatch: false };
    const newMatch = !this.roster || sorted.join(',') !== this.roster.split(':')[1] || restart;
    // Inventory can settle before the first roster does. It already belongs to this session.
    if (newMatch && this.roster) {
      const pendingInventory = this.pendingInventory;
      this.pendingInventory = [];
      this.owned = [];
      this.acquisitions = [];
      for (const observation of pendingInventory)
        this.observeInventory(observation.ids, observation.items, observation.now);
    }
    this.roster = roster;
    this.enemies = sorted;
    this.pendingInventory = [];
    if (round > 0) this.lastRound = round;
    return { changed: newMatch, newMatch };
  }
  observeInventory(ids: number[], items: Item[], now: number) {
    if (this.hits === 1 && this.roster) this.pendingInventory.push({ ids: [...ids], items, now });
    const visible = new Set(ids);
    const gained = [...visible].filter((id) => !this.owned.includes(id) && items.some((i) => i.id === id));
    for (const id of gained) this.acquisitions.push({ itemId: id, observedAt: now });
    const consumed = new Set<string>();
    for (const id of gained)
      for (const component of items.find((i) => i.id === id)!.component_items) consumed.add(component);
    this.owned = [...new Set([...this.owned, ...gained])].filter((id) => {
      const item = items.find((i) => i.id === id);
      return item && (visible.has(id) || !consumed.has(item.class_name));
    });
    return { owned: this.owned, gained };
  }
  setManualOwned(ids: number[]) {
    this.owned = [...new Set(ids)];
  }
}
