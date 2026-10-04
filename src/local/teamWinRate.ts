import type { DraftMeta } from '../brawl/recognise';
import type { BrawlTierListData } from '../brawl/tierlist';
import type { Hero } from '../types';

export interface TeamRoster {
  self: number;
  left: number[];
  right: number[];
}
export interface TeamWinRateEdge {
  ownHeroes: TeamHeroWinRate[];
  enemyHeroes: TeamHeroWinRate[];
  ownWinRate: number;
  enemyWinRate: number;
  deltaPp: number;
  window: string;
}
export interface TeamHeroWinRate {
  heroId: number;
  name: string;
  winRate: number;
}

/** Feed independent full portrait reads, never a cached metadata replay. */
export class TeamRosterConfirmation {
  value: TeamRoster | null = null;
  private candidate = '';
  private hits = 0;
  reset() {
    this.value = null;
    this.candidate = '';
    this.hits = 0;
  }
  observe(meta: DraftMeta) {
    const roster = {
      self: meta.self,
      left: meta.bar.left.map((h) => h.heroId),
      right: meta.bar.right.map((h) => h.heroId),
    };
    if (!validRoster(roster)) {
      this.candidate = '';
      this.hits = 0;
      return;
    }
    const key = JSON.stringify(roster);
    this.hits = this.candidate === key ? this.hits + 1 : 1;
    this.candidate = key;
    if (this.hits >= 2) this.value = roster;
  }
}
const validRoster = (r: TeamRoster) =>
  r.left.length === 4 &&
  r.right.length === 4 &&
  [...r.left, ...r.right].every((id) => Number.isInteger(id) && id > 0) &&
  new Set([...r.left, ...r.right]).size === 8 &&
  [...r.left, ...r.right].includes(r.self);

/** Unweighted mean of four marginal hero win rates, including the player's hero. */
export function teamWinRate(
  roster: TeamRoster | null,
  data: BrawlTierListData | null,
  heroes: Pick<Hero, 'id' | 'name'>[],
): TeamWinRateEdge | null {
  if (!roster || !data || !validRoster(roster) || data.game_mode !== 'street_brawl') return null;
  const byId = new Map(data.heroes.map((h) => [h.hero_id, h]));
  const names = new Map(heroes.map((h) => [h.id, h.name]));
  const rates = (ids: number[]) =>
    ids.map((id) => {
      const row = byId.get(id);
      const name = names.get(id)?.trim();
      return name &&
        row &&
        Number.isFinite(row.matches) &&
        row.matches > 0 &&
        Number.isFinite(row.wins) &&
        row.wins >= 0 &&
        row.wins <= row.matches
        ? { heroId: id, name, winRate: row.wins / row.matches }
        : null;
    });
  const ownLeft = roster.left.includes(roster.self);
  const own = rates(ownLeft ? roster.left : roster.right),
    enemy = rates(ownLeft ? roster.right : roster.left);
  if ([...own, ...enemy].some((n) => n === null)) return null;
  const ownHeroes = own as TeamHeroWinRate[],
    enemyHeroes = enemy as TeamHeroWinRate[];
  const mean = (xs: TeamHeroWinRate[]) => xs.reduce((sum, h) => sum + h.winRate, 0) / 4;
  const ownWinRate = mean(ownHeroes),
    enemyWinRate = mean(enemyHeroes);
  const date = (unix: number) =>
    Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toISOString().slice(0, 10) : null;
  const start = date(data.min_unix_timestamp),
    end = data.max_unix_timestamp ? date(data.max_unix_timestamp) : null;
  const fetched = Number.isFinite(Date.parse(data.fetched_at)) ? data.fetched_at.slice(0, 10) : null;
  const window = start
    ? end
      ? `${start} – ${end}`
      : `Since ${start}${fetched ? ` · fetched ${fetched}` : ''}`
    : fetched
      ? `Fetched ${fetched}`
      : 'Street Brawl snapshot';
  return { ownHeroes, enemyHeroes, ownWinRate, enemyWinRate, deltaPp: (ownWinRate - enemyWinRate) * 100, window };
}
