import type { TeamHeroWinRate, TeamWinRateEdge } from './teamWinRate';
import './TeamHeroWinRatePanel.css';

const validRate = (rate: number | null) => rate === null || (Number.isFinite(rate) && rate >= 0 && rate <= 1);
const validTeam = (heroes: TeamHeroWinRate[] | undefined) =>
  heroes?.length === 4 &&
  heroes.every((h) => h.name?.trim() && validRate(h.winRate) && (h.winRate !== null || !!h.unavailable));
const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

function TeamColumn({ label, heroes, average }: { label: string; heroes: TeamHeroWinRate[]; average: number | null }) {
  return (
    <section className="team-hero-wr-team" aria-label={label}>
      <div className="team-hero-wr-average">
        <span>{label} avg</span>
        <strong>{average === null ? 'Unavailable' : percent(average)}</strong>
      </div>
      <ul aria-label={`${label} hero win rates`}>
        {heroes.map((hero, slot) => (
          <li key={slot}>
            <span className="team-hero-wr-name">{hero.name}</span>
            <span>
              {hero.winRate !== null
                ? percent(hero.winRate)
                : hero.unavailable === 'reading-hero'
                  ? 'Reading…'
                  : hero.unavailable === 'loading-data'
                    ? 'Loading rates…'
                    : 'No win-rate data'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TeamHeroWinRatePanel({
  visible,
  draft,
  round,
  edge,
}: {
  visible?: boolean;
  draft?: boolean;
  round?: number;
  edge?: TeamWinRateEdge | null;
}) {
  if (
    !(visible ?? (draft && round === 1)) ||
    !edge ||
    !validRate(edge.ownWinRate) ||
    !validRate(edge.enemyWinRate) ||
    (edge.deltaPp !== null && !Number.isFinite(edge.deltaPp)) ||
    !validTeam(edge.ownHeroes) ||
    !validTeam(edge.enemyHeroes)
  )
    return null;
  if (
    [...edge.ownHeroes, ...edge.enemyHeroes].some((h) => h.winRate === null) &&
    (edge.ownWinRate !== null || edge.enemyWinRate !== null || edge.deltaPp !== null)
  )
    return null;
  const delta = edge.deltaPp;
  const direction = delta !== null && delta > 0 ? 'positive' : delta !== null && delta < 0 ? 'negative' : 'neutral';
  const difference =
    delta === null ? 'Unavailable' : delta !== 0 && Math.abs(delta) < 0.05 ? '<0.1' : Math.abs(delta).toFixed(1);
  return (
    <aside className="team-hero-wr" data-direction={direction} aria-label="Team average hero win rates">
      <div className="team-hero-wr-title">Street Brawl · Hero win rates</div>
      <div className="team-hero-wr-teams">
        <TeamColumn label="Ours" heroes={edge.ownHeroes} average={edge.ownWinRate} />
        <TeamColumn label="Enemy" heroes={edge.enemyHeroes} average={edge.enemyWinRate} />
      </div>
      <div className="team-hero-wr-difference">
        <span>Difference</span>
        <strong>
          {delta !== null && delta > 0 ? '+' : delta !== null && delta < 0 ? '−' : ''}
          {difference}
          {delta === null ? '' : ' pp'}
        </strong>
      </div>
      <div className="team-hero-wr-proxy">Mean hero WR · composition proxy</div>
      {edge.window && <div className="team-hero-wr-source">{edge.window}</div>}
    </aside>
  );
}
