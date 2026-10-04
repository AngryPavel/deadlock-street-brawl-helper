import { describe, expect, it } from 'vitest';
import { items, itemByName } from '../../brawl/__tests__/testData';
import { matchCardName } from '../cardNameMatch';

const names = Object.fromEntries(items.map((item) => [item.id, item.name]));

describe('complete catalogue name matching', () => {
  it('matches unique exact names, including short names and punctuation', () => {
    expect(matchCardName('DIVINER’S KEVLAR', names)).toEqual({
      itemId: itemByName("Diviner's Kevlar").id,
      kind: 'exact',
    });
    expect(matchCardName('Abc', { 1: 'ABC' })).toEqual({ itemId: 1, kind: 'exact' });
    expect(matchCardName('', names)).toMatchObject({ itemId: 0, reason: 'empty-text' });
    expect(matchCardName('Diviner', names).itemId).toBe(0);
  });
  it.each([
    ["Diviner's Keular", "Diviner's Kevlar"],
    ['Monster Roundz', 'Monster Rounds'],
    ['Tankbuzter', 'Tankbuster'],
    ['Superoir Duration', 'Superior Duration'],
  ])('corrects distinctive whole-string OCR edits: %s', (text, target) => {
    expect(matchCardName(text, names)).toEqual({ itemId: itemByName(target).id, kind: 'corrected' });
  });
  it('rejects ties, nearby runners-up, duplicate normalized names, and excessive edits', () => {
    expect(matchCardName('Tankbuzter', { 1: 'Tankbuster', 2: 'Tankbaster' })).toMatchObject({
      itemId: 0,
      reason: 'ambiguous-name',
    });
    expect(matchCardName('Tankbuzter', { 1: 'Tankbuster', 2: 'TANK-BUSTER' })).toMatchObject({
      itemId: 0,
      reason: 'ambiguous-name',
    });
    expect(matchCardName('Tankbuster', { 1: 'Tankbuster', 2: 'TANK-BUSTER' }).itemId).toBe(0);
    expect(matchCardName('abcdeg', { 1: 'abcdef', 2: 'abcdhi' }).itemId).toBe(0);
    expect(matchCardName('abxde', { 1: 'abcde' }).itemId).toBe(0);
    expect(matchCardName('Takbuzter', { 1: 'Tankbuster' }).itemId).toBe(0);
    expect(matchCardName('Sxxerixr Duration', { 1: 'Superior Duration' }).itemId).toBe(0);
  });
});
