import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isShopScreen } from '../../src/brawl/recognise';

// A CHOICE 1 frame scaled to 1312 or 1600 px wide left a stray lit pixel at the edge of the glyph box, which stretched
// its bounding box so the probe never fired on that draft screen (a real "nothing appears" cause). Draft frames must hit
// at every width, the in-round frame at none.
const hit = async (file: string, w: number) => {
  const h = Math.round((w * 9) / 16);
  const { data } = await sharp(file)
    .resize(w, h, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return isShopScreen({ width: w, height: h, data: new Uint8ClampedArray(data), channels: 4 });
};

describe('draft probe across window sizes', () => {
  it.each([1312, 1600, 1920])('reads the choice-1 draft screen at %i px wide', async (w) => {
    expect(await hit('public/demo/choice1.png', w)).toBe(true);
  });
  it.each([1312, 1600, 1920])('stays silent on the in-round frame at %i px wide', async (w) => {
    expect(await hit('public/demo/gameplay.png', w)).toBe(false);
  });
});
