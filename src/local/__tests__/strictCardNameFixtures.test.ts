import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cardNameRegions, itemNameCrop } from '../cardNames';
import { exactCardNameId } from '../cardNameConfirmation';
import { readItemName, stopItemNameOCR } from '../cardNameOcr';
import { itemByName, items } from '../../brawl/__tests__/testData';
const names = Object.fromEntries(items.map((item) => [item.id, item.name]));
afterAll(stopItemNameOCR);
describe('strict positive text evidence for existing weak direct fixtures', () => {
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
