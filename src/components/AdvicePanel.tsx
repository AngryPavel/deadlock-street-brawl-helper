import type { BrawlInput, Offer, RankedOffer, RerollAdvice } from '../brawl';
import type { Hero } from '../types';
import { ItemTile } from './ItemTile';

interface AdvicePanelProps {
  input: BrawlInput | null;
  error: string | null;
  cards: Offer[];
  capture: 'off' | 'starting' | 'on';
  status: string;
  lastTaken: string;
  owned: number[];
  ranked: RankedOffer[];
  reroll: RerollAdvice | null;
  rerolls: number;
  hero: Hero;
  took: (r: RankedOffer) => void;
  rerolled: () => void;
}

/** Split out so the loading/error state (shown while `input` is null, e.g. right after a hero change)
 *  never has to gate what renders above it in BrawlView — see the "never early-return before <video>" note. */
export function AdvicePanel({
  input,
  error,
  cards,
  capture,
  status,
  lastTaken,
  owned,
  ranked,
  reroll,
  rerolls,
  hero,
  took,
  rerolled,
}: AdvicePanelProps) {
  if (!input) {
    return (
      <div className="brawl-advice">
        {error ? <div className="error">{error}</div> : <div className="loading">Loading Street Brawl data…</div>}
      </div>
    );
  }
  return (
    <div className="brawl-advice">
      {reroll && (
        <div className="brawl-reroll-banner">
          RE-ROLL this set — expected best {reroll.expectedBest.toFixed(2)} vs {reroll.currentBest.toFixed(2)} on screen
          <button className="btn" onClick={rerolled}>
            I re-rolled
          </button>
        </div>
      )}
      {!cards.length && (
        <div className="muted">
          {capture === 'on'
            ? status
            : 'No cards yet. Start the screen capture above, or pick the three cards yourself in "Cards on screen" below.'}
        </div>
      )}
      {lastTaken && (
        <div className="muted">
          Took {lastTaken} · {owned.length} owned
        </div>
      )}
      {ranked.map((r, k) => (
        <button
          key={r.item.id}
          className={`brawl-card ${k === 0 && !reroll ? 'best' : ''}`}
          onClick={() => took(r)}
          title={`score ${r.score.toFixed(2)} · ${
            capture === 'on' ? 'picks are read from the inventory grid; click only if it missed' : 'I took this one'
          }`}
        >
          <ItemTile item={r.item} />
          <span className="brawl-card-body">
            <b>
              {k === 0 && !reroll ? 'TAKE' : `#${k + 1}`} {r.item.name}
              {r.enhanced ? ' (enhanced)' : ''}
            </b>
            <small>
              score {r.score.toFixed(2)} ·{' '}
              {k === 0 ? 'best' : `−${((1 - r.score / ranked[0].score) * 100).toFixed(0)}% vs best`} · used by{' '}
              {(r.usage * 100).toFixed(0)}% of {hero.name}s
              {r.winRate !== null ? `, wins ${(r.winRate * 100).toFixed(0)}%` : ''}
              {r.known ? '' : ' · no brawl data'}
            </small>
            {r.why.length > 0 && <small>{r.why.join('; ')}</small>}
          </span>
        </button>
      ))}
      {reroll && reroll.holdValue > 0 && (
        <div className="muted">saving this set for a later choice is worth {reroll.holdValue.toFixed(2)}</div>
      )}
      {cards.length > 0 && !reroll && <div className="muted">Keep this set{rerolls ? '' : ' (no re-rolls left)'}.</div>}
    </div>
  );
}
