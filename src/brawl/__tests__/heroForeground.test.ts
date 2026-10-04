import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeIconIndex, HERO_BAR, hudLayout, readDraftMeta, type RGBImage } from '../recognise';

const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
async function preparationBar(fixture = 'preparation-team-bar'): Promise<RGBImage> {
  const root = `src/brawl/__tests__/assets/${fixture}`;
  const { width, height, region } = JSON.parse(readFileSync(`${root}.json`, 'utf8'));
  const pixels = await sharp(`${root}.webp`).ensureAlpha().raw().toBuffer();
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < region.height; y++)
    data.set(
      pixels.subarray(y * region.width * 4, (y + 1) * region.width * 4),
      ((region.y + y) * width + region.x) * 4,
    );
  return { width, height, channels: 4, data };
}

describe('bounded foreground fallback for unread portraits', () => {
  it('reads the supplied preparation lineup under unchanged score/margin gates and preserves every admitted primary', async () => {
    const image = await preparationBar();
    const primary = readDraftMeta(image, { ...index, heroForeground: undefined });
    const recovered = readDraftMeta(image, index);
    expect(primary.bar.left.map((match) => match.heroId)).toEqual([76, 0, 84, 0]);
    expect(recovered.bar.left.map((match) => match.heroId)).toEqual([76, 35, 84, 25]);
    expect(recovered.bar.right.map((match) => match.heroId)).toEqual([16, 13, 6, 72]);
    expect(recovered.self).toBe(76);
    for (const side of ['left', 'right'] as const)
      for (let slot = 0; slot < 4; slot++)
        if (primary.bar[side][slot]!.heroId) expect(recovered.bar[side][slot]).toEqual(primary.bar[side][slot]);
    for (const slot of [1, 3]) {
      expect(recovered.bar.left[slot]!.score).toBeGreaterThanOrEqual(0.6);
      expect(recovered.bar.left[slot]!.margin).toBeGreaterThanOrEqual(0.08);
    }
  });
  it('recovers the second real first-round lineup with Bebop and Doorman while preserving its primary portraits', async () => {
    const image = await preparationBar('first-round-bebop-doorman-bar');
    const primary = readDraftMeta(image, { ...index, heroForeground: undefined });
    const recovered = readDraftMeta(image, index);
    expect(primary.bar.left.map((match) => match.heroId)).toEqual([0, 0, 84, 76]);
    expect(recovered.bar.left.map((match) => match.heroId)).toEqual([15, 69, 84, 76]);
    expect(recovered.bar.right.map((match) => match.heroId)).toEqual([77, 31, 64, 2]);
    expect(recovered.self).toBe(76);
    for (const side of ['left', 'right'] as const)
      for (let slot = 0; slot < 4; slot++)
        if (primary.bar[side][slot]!.heroId) expect(recovered.bar[side][slot]).toEqual(primary.bar[side][slot]);
  });
  it.each(['blank', 'occluded'])('keeps %s portraits unread despite visible neighboring heroes', async (mode) => {
    const image = await preparationBar();
    const { sx, sy, offsetX } = hudLayout(image.width, image.height);
    for (const slot of [1, 3]) {
      const cx = offsetX + HERO_BAR.left[slot]! * sx,
        cy = HERO_BAR.cy * sy;
      const radius = (mode === 'blank' ? 52 : 35) * sx;
      for (let y = Math.max(0, Math.floor(cy - radius)); y < cy + radius; y++)
        for (let x = Math.floor(cx - radius); x < cx + radius; x++)
          image.data.set([58, 74, 88, 255], (y * image.width + x) * 4);
    }
    const meta = readDraftMeta(image, index);
    expect(meta.bar.left.map((match) => match.heroId)).toEqual([76, 0, 84, 0]);
    expect(meta.bar.right.map((match) => match.heroId)).toEqual([16, 13, 6, 72]);
  });
  it('rejects uniform and tiny-support references rather than inflating their masked correlation', async () => {
    const image = await preparationBar();
    const raw = JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8'));
    const fill = Buffer.from(new Uint8Array(raw.size * raw.size * 3).fill(200));
    const uniform = decodeIconIndex({ ...raw, heroes: { 999: fill.toString('base64') } });
    expect(readDraftMeta(image, uniform).bar.left.every((match) => match.heroId === 0)).toBe(true);
    const tiny = Buffer.alloc(raw.size * raw.size * 3);
    for (let i = 0; i < raw.size * raw.size; i++) tiny.set([58, 74, 88], i * 3);
    tiny.set([255, 0, 255], (Math.floor(raw.size / 2) * raw.size + Math.floor(raw.size / 2)) * 3);
    const small = decodeIconIndex({ ...raw, heroes: { 999: tiny.toString('base64') } });
    expect(readDraftMeta(image, small).bar.left.every((match) => match.heroId === 0)).toBe(true);
  });
});
