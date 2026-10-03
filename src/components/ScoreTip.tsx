import type { OverlayAdviceCard } from '../brawl/draw';
import { formatSigned, NO_DATA_LABEL } from '../brawl/breakdown';

/** Score breakdown shown beside a plate on hover: item name and tier, one row per score part (fixed label, signed
 *  number), then the total. Numbers and fixed labels only. */
export function ScoreTip({
  card,
  className = 'overlay-tip',
  style,
}: {
  card: OverlayAdviceCard;
  className?: string;
  style?: React.CSSProperties;
}) {
  const noData = card.rows.length === 1 && card.rows[0].label === NO_DATA_LABEL;
  return (
    <div className={className} style={style} role="tooltip">
      <div className="tip-head">
        {card.name} · {card.grade}
      </div>
      {card.rows.map((r) => (
        <div key={r.label} className="tip-row">
          <span>{r.label}</span>
          {!noData && <b>{formatSigned(r.cents)}</b>}
        </div>
      ))}
      {!noData && (
        <div className="tip-row tip-total">
          <span>Score</span>
          <b>{card.score.toFixed(2)}</b>
        </div>
      )}
    </div>
  );
}
