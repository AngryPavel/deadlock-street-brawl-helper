import { describe, expect, it } from 'vitest';
import { LocalOfferJournal, OFFER_JOURNAL_KEY, offerPatch, journalCards } from '../offerJournal';
import { offeredSamples } from '../dropDistribution';
import { items } from '../../brawl/__tests__/testData';

const context = { patch: 'patch-a', heroId: 1, round: 2, choice: 1 };
const cards = [1, 2, 3].map((itemId) => ({ itemId, tier: 2, rare: false, enhanced: false }));
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
describe('accepted offered-card journal', () => {
  it('uses the current choice tier for all three slots, including plain third-choice cards', () => {
    const catalog = new Map(items.map((item) => [item.id, item]));
    const normal = items.find((item) => item.item_tier === 3)!;
    const rare = items.find((item) => item.item_tier === 4)!;
    const tiers = { normal_mod_tier: 3, rare_mod_tier: 4 };
    const plain = journalCards(Array(3).fill({ itemId: normal.id }), catalog, tiers)!;
    expect(plain.map((card) => card.rare)).toEqual([false, false, false]);
    expect(
      journalCards(
        [{ itemId: normal.id }, { itemId: rare.id, enhanced: true }, { itemId: normal.id }],
        catalog,
        tiers,
      )!.map((card) => [card.rare, card.enhanced]),
    ).toEqual([
      [false, false],
      [true, true],
      [false, false],
    ]);
  });
  it('deduplicates frames, retains unchosen cards, and permits identical confirmed rerolls', () => {
    const store = storage();
    const journal = new LocalOfferJournal(store);
    expect(journal.recordAccepted(context, cards, 'initial', 1)).toBe(true);
    for (let i = 0; i < 5; i++) expect(journal.recordAccepted(context, cards, 'initial', 2)).toBe(false);
    journal.markReroll(context);
    expect(journal.recordAccepted(context, cards, 'reroll', 3)).toBe(true);
    const rows = journal.exportObservations();
    expect(rows.map((r) => r.generation)).toEqual(['initial', 'reroll']);
    expect(rows[0].cards.map((c) => c.itemId)).toEqual([1, 2, 3]);
    expect(new LocalOfferJournal(store).exportObservations()).toEqual(rows);
    expect(rows[0].source).toBe('offered-cards');
  });
  it('bounds storage and isolates patch, hero, round, choice, and match generations', () => {
    const store = storage();
    const journal = new LocalOfferJournal(store, 3);
    journal.recordAccepted(context, cards, 'initial', 1);
    journal.recordAccepted({ ...context, choice: 2 }, cards, 'initial', 2);
    journal.startSession();
    journal.recordAccepted(context, cards, 'initial', 3);
    journal.recordAccepted({ ...context, patch: 'patch-b' }, cards, 'initial', 4);
    const rows = journal.exportObservations();
    expect(rows).toHaveLength(3);
    expect(offeredSamples(rows, context)).toHaveLength(2);
    expect(offeredSamples(rows, { ...context, heroId: 2 })).toEqual([]);
    expect(offeredSamples(rows, { ...context, round: 3 })).toEqual([]);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(3);
    expect(JSON.parse(store.getItem(OFFER_JOURNAL_KEY)!)).toHaveLength(3);
  });
  it('rejects incomplete sets and corrupt persisted data; exports cannot mutate evidence', () => {
    const store = storage();
    store.setItem(OFFER_JOURNAL_KEY, '{broken');
    const journal = new LocalOfferJournal(store);
    expect(journal.recordAccepted(context, cards.slice(0, 2), 'initial', 1)).toBe(false);
    journal.recordAccepted(context, cards, 'initial', 2);
    const exported = journal.exportObservations();
    exported[0].patch = 'changed';
    expect(journal.exportObservations()[0].patch).toBe('patch-a');
    expect(offerPatch(undefined)).toBeNull();
    expect(offerPatch({ role: 'primary', patch_id: null, min_unix_timestamp: 42 })).toBe('cutoff:42');
  });
});
