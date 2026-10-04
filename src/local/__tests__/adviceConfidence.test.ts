import { describe, expect, it } from 'vitest';
import { adviseDraft } from '../../brawl/engine';
import { heroByName, inputFor, itemByName } from '../../brawl/__tests__/testData';
import { adviceConfidence } from '../adviceConfidence';

describe('qualitative advice evidence', () => {
  it('shows close gaps, absent evidence, legacy windows and approximate reroll assumptions', () => {
    const input = inputFor(heroByName('Infernus').id);
    const itemId = itemByName('Extra Stamina').id;
    const ranked = adviseDraft(input, { round: 1, owned: [], enemies: [], sets: [[{ itemId }, { itemId }], [], []] })
      .sets[0];
    const limited = ranked.map((r) => ({ ...r, known: false }));
    const text = adviceConfidence(input, limited, null, 1);
    expect(text).toContain('Close scores');
    expect(text).toContain('limited item samples');
    expect(text).toContain('legacy stats window');
    expect(text).toContain('match-wide stats');
    expect(text).toContain('uniform reroll approximation');
    expect(text).not.toContain('%');
  });
  it('identifies valid purchase-round evidence without calling match outcomes round wins', () => {
    const input = inputFor(heroByName('Infernus').id);
    const itemId = itemByName('Extra Stamina').id;
    input.analytics = {
      ...input.analytics,
      hero_stats: { wins: 500, matches: 1000 },
      round_item_stats: [{ item_id: itemId, round: 1, wins: 300, matches: 500 }],
      round_item_stats_provenance: {
        endpoint: '/v1/analytics/item-flow-stats',
        phase_count: 5,
        round_semantics: 'purchase_round',
        outcome_semantics: 'match_win',
        count_semantics: 'purchase',
        reached_per_round: [1000],
      },
    };
    const ranked = adviseDraft(input, { round: 1, owned: [], enemies: [], sets: [[{ itemId }], [], []] }).sets[0];
    const text = adviceConfidence(input, ranked, null, 1);
    expect(text).toContain('purchase-round / match-win stats');
    expect(text).not.toContain('neutral hero baseline');
  });
});
