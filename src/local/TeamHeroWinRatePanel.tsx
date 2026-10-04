import type { TeamWinRateEdge } from './teamWinRate';
import './TeamHeroWinRatePanel.css';

export function TeamHeroWinRatePanel({
  draft,
  round,
  edge,
}: {
  draft?: boolean;
  round?: number;
  edge?: TeamWinRateEdge | null;
}) {
  if (
    !draft ||
    round !== 1 ||
    !edge ||
    ![edge.ownWinRate, edge.enemyWinRate, edge.deltaPp].every(Number.isFinite) ||
    edge.ownWinRate < 0 ||
    edge.ownWinRate > 1 ||
    edge.enemyWinRate < 0 ||
    edge.enemyWinRate > 1
  )
    return null;
  const delta = Math.abs(edge.deltaPp) < 0.05 ? 0 : edge.deltaPp;
  const direction = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
  return (
    <aside className="team-hero-wr" aria-label="Team average hero win rates">
      <div className="team-hero-wr-title">Average hero WR · 4 vs 4</div>
      <div className="team-hero-wr-values">
        <span>Ours {(edge.ownWinRate * 100).toFixed(1)}%</span>
        <span>Enemy {(edge.enemyWinRate * 100).toFixed(1)}%</span>
        <strong data-direction={direction}>
          {delta > 0 ? '+' : ''}
          {delta.toFixed(1)} pp
        </strong>
      </div>
      <div className="team-hero-wr-proxy">Hero WR edge · composition proxy</div>
      {edge.window && <div className="team-hero-wr-source">{edge.window}</div>}
    </aside>
  );
}
