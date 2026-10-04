import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeIconIndex, HERO_BAR, readPlayerHero, type RGBImage } from '../recognise';
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
describe('independent player marker and portrait read', () => {
  it('rejects the adjacent dark-gap alias and identifies Graves in the actual reported bar', async () => {
    const { width, height, region } = JSON.parse(
      readFileSync('src/brawl/__tests__/assets/graves-player-bar.json', 'utf8'),
    );
    const data = new Uint8ClampedArray(width * height * 4);
    const pixels = await sharp('src/brawl/__tests__/assets/graves-player-bar.webp').ensureAlpha().raw().toBuffer();
    for (let y = 0; y < region.height; y++)
      data.set(
        pixels.subarray(y * region.width * 4, (y + 1) * region.width * 4),
        ((region.y + y) * width + region.x) * 4,
      );
    expect(readPlayerHero({ width, height, channels: 4, data }, index)).toEqual({ heroId: 76, side: 'left', slot: 2 });
  });
  it.each(['s7', 's8', 's9', 's10', 's13', 's14', 's15', 's16', 's17'])(
    'preserves the existing Infernus marker in %s',
    async (name) => {
      const { data, info } = await sharp(`scripts/fixtures/brawl-screens/${name}.png`)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(readPlayerHero({ width: info.width, height: info.height, channels: 4, data }, index)).toEqual({
        heroId: 1,
        side: 'left',
        slot: 1,
      });
    },
  );
  it('rejects blank frames and a banner that draws a bright tile around all eight slots', () => {
    const img: RGBImage = { width: 2560, height: 1440, channels: 4, data: new Uint8ClampedArray(2560 * 1440 * 4) };
    expect(readPlayerHero(img, index)).toBeNull();
    const radius = HERO_BAR.diameter / 2;
    for (const cx of [...HERO_BAR.left, ...HERO_BAR.right])
      for (let y = Math.round(HERO_BAR.cy - radius); y < HERO_BAR.cy + radius; y++)
        for (let x = Math.round(cx - radius); x < cx + radius; x++) {
          const i = (y * img.width + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 210;
          img.data[i + 3] = 255;
        }
    expect(readPlayerHero(img, index)).toBeNull();
  });
});
