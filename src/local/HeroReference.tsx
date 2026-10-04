import type { Hero } from '../types';
import type { BrawlAbilityOrder, AbilityPanelData } from '../brawl/abilities';
import type { topItemsByTier } from '../brawl/engine';
import { AbilityPanel } from '../components/AbilityPanel';
import { ItemTile } from '../components/ItemTile';
import './HeroReference.css';

/** The selected hero's reference stays available before capture and between drafts. */
export function HeroReference({
  hero,
  topItems,
  abilityOrder,
  abilityTarget,
  abilityStepNow,
}: {
  hero: Hero;
  topItems: ReturnType<typeof topItemsByTier>;
  abilityOrder: BrawlAbilityOrder | null;
  abilityTarget: AbilityPanelData | null;
  abilityStepNow: number;
}) {
  return (
    <section className="hero-reference" aria-label={`${hero.name} reference`}>
      <div className="panel">
        <h2>{hero.name}'s top items</h2>
        <div className="muted">Suggested picks in each tier, independent of the cards currently offered.</div>
        {topItems.length ? (
          <div className="top-items">
            {topItems.map(({ tier, items }) => (
              <div key={tier} className="top-items-tier">
                <h3>Tier {tier}</h3>
                <div className="tiles">
                  {items.map((b, k) => (
                    <ItemTile key={b.item.id} item={b.item} order={k + 1} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Item suggestions appear when the hero's Street Brawl snapshot is available.</p>
        )}
      </div>
      <div className="panel">
        <h2>Ability order</h2>
        {abilityOrder?.steps.length ? (
          <>
            {abilityOrder.support ? (
              <div className="muted">
                Seen in {abilityOrder.support.matches} brawls, match wins{' '}
                {(abilityOrder.support.winRate * 100).toFixed(0)}%.
              </div>
            ) : (
              <div className="muted">No Street Brawl ability data for {hero.name} yet; fallback order shown.</div>
            )}
            {abilityTarget && <AbilityPanel panel={abilityTarget} className="ap-control" />}
            <ol className="brawl-ability-order">
              {abilityOrder.steps.map((step, k) => (
                <li key={k} className={k === abilityStepNow ? 'now' : ''}>
                  {step.ability.name} <small>(tier {step.kind.slice(-1)})</small>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="muted">Ability upgrades appear when the hero's Street Brawl snapshot is available.</p>
        )}
      </div>
    </section>
  );
}
