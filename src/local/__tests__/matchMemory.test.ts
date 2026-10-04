import { describe, expect, it } from 'vitest';
import { MatchMemory } from '../matchMemory';
import { InventoryConfirmation } from '../inventoryConfirmation';
import { items, itemByName } from '../../brawl/__tests__/testData';

describe('confirmed match state', () => {
  it('corrects player identity or side within the same match without erasing purchases', () => {
    const m = new MatchMemory();
    m.observeRoster(67, [2, 3, 4, 5], 4);
    m.observeRoster(67, [2, 3, 4, 5], 4);
    const bought = itemByName('Extra Stamina').id;
    m.observeInventory([bought], items, 10);
    m.observeRoster(76, [2, 3, 4, 5], 4);
    expect(m.observeRoster(76, [2, 3, 4, 5], 4).newMatch).toBe(false);
    expect(m.observeRoster(76, [6, 7, 8, 9], 4, true).newMatch).toBe(false);
    expect(m.enemies).toEqual([6, 7, 8, 9]);
    expect(m.owned).toEqual([bought]);
    expect(m.acquisitions).toEqual([{ itemId: bought, observedAt: 10 }]);
    m.observeRoster(64, [6, 7, 8, 9], 1);
    expect(m.observeRoster(64, [6, 7, 8, 9], 1).newMatch).toBe(true);
    expect(m.owned).toEqual([]);
  });
  it('requires the second inventory read even when cards and pixels are already settled', () => {
    const latch = new InventoryConfirmation();
    const outputs: (number[] | null)[] = [];
    for (let frame = 0; frame < 5; frame++)
      if (latch.needsRead('same-frame')) outputs.push(latch.observe([1, 2], 'same-frame'));
    expect(outputs).toEqual([null, [1, 2]]);
    expect(latch.needsRead('inventory-only-change')).toBe(true);
    expect(latch.observe([1, 2, 3], 'inventory-only-change')).toBeNull();
    expect(latch.needsRead('inventory-only-change')).toBe(true);
    expect(latch.observe([1, 2, 3], 'inventory-only-change')).toEqual([1, 2, 3]);
  });
  it('replaces a full enemy team only after stable evidence and resets inventory in the new game', () => {
    const m = new MatchMemory();
    m.observeRoster(1, [2, 3, 4, 5], 3);
    m.observeRoster(1, [2, 3, 4, 5], 3);
    m.setManualOwned([items[0].id]);
    expect(m.observeRoster(1, [6, 7, 8, 9], 1).newMatch).toBe(false);
    expect(m.owned).toHaveLength(1);
    expect(m.observeRoster(1, [6, 7, 8, 9], 1).newMatch).toBe(true);
    expect(m.enemies).toEqual([6, 7, 8, 9]);
    expect(m.owned).toEqual([]);
    m.observeRoster(1, [6], 1);
    expect(m.enemies).toEqual([6, 7, 8, 9]);
  });
  it('does not lose acquired items beyond the visible cells or add unchosen offers', () => {
    const m = new MatchMemory(),
      draftable = items
        .filter((i) => i.item_tier > 0 && !i.disabled)
        .slice(0, 15)
        .map((i) => i.id);
    m.observeInventory(draftable.slice(0, 10), items, 0);
    m.observeInventory(draftable.slice(5), items, 100);
    expect(m.owned).toHaveLength(15);
    m.observeInventory([], items, 200);
    expect(m.owned).toHaveLength(15);
    expect(m.acquisitions).toHaveLength(15);
  });
  it('removes a consumed component only after its actual upgrade is observed', () => {
    const upgrade = items.find(
      (i) => i.component_items.length > 0 && i.component_items.some((c) => items.some((x) => x.class_name === c)),
    )!;
    const component = items.find((i) => upgrade.component_items.includes(i.class_name))!;
    const m = new MatchMemory();
    m.observeInventory([component.id], items, 0);
    m.observeInventory([], items, 100);
    expect(m.owned).toEqual([component.id]);
    m.observeInventory([upgrade.id], items, 200);
    expect(m.owned).toEqual([upgrade.id]);
  });
  it('detects a fresh first round with the same hero and same enemy team', () => {
    const m = new MatchMemory();
    m.observeRoster(1, [2, 3, 4, 5], 4);
    m.observeRoster(1, [2, 3, 4, 5], 4);
    m.setManualOwned([itemByName('Extra Stamina').id]);
    expect(m.observeRoster(1, [2, 3, 4, 5], 1).newMatch).toBe(false);
    expect(m.owned).toEqual([itemByName('Extra Stamina').id]);
    expect(m.observeRoster(1, [2, 3, 4, 5], 1).newMatch).toBe(true);
    expect(m.owned).toEqual([]);
  });
  it('keeps inventory confirmed before the initial roster and only records actual acquisitions', () => {
    const m = new MatchMemory();
    const bought = itemByName('Extra Stamina').id;
    m.observeInventory([bought], items, 10);
    m.observeRoster(1, [2, 3, 4, 5], 1);
    expect(m.observeRoster(1, [2, 3, 4, 5], 1).newMatch).toBe(true);
    expect(m.owned).toEqual([bought]);
    expect(m.acquisitions).toEqual([{ itemId: bought, observedAt: 10 }]);
  });
  it('carries inventory observed during new-roster confirmation into the new match', () => {
    const m = new MatchMemory();
    const previous = itemByName('Extra Stamina').id;
    const bought = items.find((i) => i.item_tier > 0 && i.id !== previous)!.id;
    m.observeRoster(1, [2, 3, 4, 5], 4);
    m.observeRoster(1, [2, 3, 4, 5], 4);
    m.observeInventory([previous], items, 10);
    m.observeRoster(1, [6, 7, 8, 9], 1);
    m.observeInventory([bought], items, 20);
    m.observeRoster(1, [6, 7, 8, 9], 1);
    expect(m.owned).toEqual([bought]);
    expect(m.acquisitions).toEqual([{ itemId: bought, observedAt: 20 }]);
  });
});
