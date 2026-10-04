import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { cardNameRegions, itemNameCrop } from '../cardNames';
import { CardNameConfirmation, exactCardNameId, strongDirectCard } from '../cardNameConfirmation';
import { readItemName, stopItemNameOCR } from '../cardNameOcr';
import { matchCardName } from '../cardNameMatch';
import { itemByName, items } from '../../brawl/__tests__/testData';
import { cardAnchors, decodeIconIndex, readDraftScreen } from '../../brawl/recognise';
const names = Object.fromEntries(items.map((item) => [item.id, item.name]));
const loadDraft = async (fixture: string) => {
  const root = `src/brawl/__tests__/assets/${fixture}`;
  const layout = JSON.parse(readFileSync(`${root}.json`, 'utf8')) as {
    width: number;
    height: number;
    regions: { x: number; y: number; width: number; height: number; top: number }[];
  };
  const { data: packed, info } = await sharp(`${root}.webp`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = new Uint8Array(layout.width * layout.height * 4);
  for (const region of layout.regions)
    for (let y = 0; y < region.height; y++)
      data.set(
        packed.subarray((region.top + y) * info.width * 4, ((region.top + y) * info.width + region.width) * 4),
        ((region.y + y) * layout.width + region.x) * 4,
      );
  return { data, width: layout.width, height: layout.height, channels: 4 as const };
};
afterAll(stopItemNameOCR);
describe('strict positive text evidence for existing weak direct fixtures', () => {
  it.each([
    {
      fixture: 'settled-round3-choice2',
      slot: 0,
      offers: ['Spellslinger', 'Superior Duration', 'Burst Fire'],
      rare: true,
    },
    {
      fixture: 'settled-round4-choice3-enhanced',
      slot: 1,
      offers: ['Vortex Web', 'Spellslinger', 'Transcendent Cooldown'],
      rare: false,
    },
  ])(
    '$fixture recovers complete names and leaves strong neighbors alone',
    async ({ fixture, slot, offers, rare }) => {
      const image = await loadDraft(fixture);
      const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
      const tiers = Object.fromEntries(items.map((item) => [item.id, item.item_tier]));
      const reads = readDraftScreen(image, index, (id) => tiers[id] ?? 0);
      const direct = reads.map(strongDirectCard);
      expect(direct[slot]).toBe(false);
      expect(direct[2]).toBe(true);
      const primary = itemNameCrop(
        image,
        cardNameRegions(image.width, image.height, cardAnchors(image.width, image.height))[slot]!,
      );
      const first = await readItemName(primary);
      const primaryMatch = matchCardName(first.text, names);
      const readText = vi.fn(readItemName);
      const resolved = await new CardNameConfirmation(readText).resolve(image, reads, names, tiers, 'regression');
      expect(resolved?.map((read) => read.itemId)).toEqual(offers.map((name) => itemByName(name).id));
      expect(resolved?.[slot]).toMatchObject({ enhanced: true, rare });
      for (let neighbor = 0; neighbor < direct.length; neighbor++)
        if (direct[neighbor]) expect(resolved?.[neighbor]).toBe(reads[neighbor]);
      const retries = primaryMatch.itemId ? 0 : 1;
      expect(readText.mock.calls.filter(([crop]) => crop.interpolation === 'nearest')).toHaveLength(retries);
      expect(readText.mock.calls).toHaveLength(direct.filter((strong) => !strong).length + retries);
    },
    20_000,
  );
  it.each([
    ['s8-top', 'Spirit Sap'],
    ['s15-top', 'Spirit Snatch'],
    ['s9-right', 'Mercurial Magnum'],
  ])(
    '%s independently confirms %s',
    async (fixture, name) => {
      const { data, info } = await sharp(`scripts/fixtures/brawl-cards/${fixture}.png`)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const region = cardNameRegions(info.width, info.height, [
        { cx: info.width / 2, cy: info.height / 2, icon: 185 },
      ])[0]!;
      const crop = itemNameCrop({ width: info.width, height: info.height, channels: 4, data }, region);
      const text = await readItemName(crop);
      expect(exactCardNameId(text.text, text.confidence, names), JSON.stringify(text)).toBe(itemByName(name).id);
    },
    20_000,
  );
});
