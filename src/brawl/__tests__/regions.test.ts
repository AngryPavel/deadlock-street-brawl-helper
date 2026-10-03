import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeIconIndex,
  draftRegions,
  extractRerollLabelCrop,
  readDraftMeta,
  readDraftScreen,
  readInventory,
  readRoundChoice,
  type RGBImage,
} from '../recognise';
import { items } from './testData';

// Measured alone these take 1-2 s (recognise: 1.8 s, regions: ~1 s each); with the whole suite running in parallel on a
// busy machine they pass the 5 s default, so this file gets 20 s. Nothing is skipped or weakened.
vi.setConfig({ testTimeout: 20_000 });

const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const tierOf = (id: number) => items.find((i) => i.id === id)?.item_tier ?? 0;

const everything = (img: RGBImage) => {
  const reads = readDraftScreen(img, index, tierOf);
  return {
    reads,
    meta: readDraftMeta(img, index),
    labels: readRoundChoice(img),
    crop: extractRerollLabelCrop(img),
    inv: readInventory(
      img,
      index,
      reads.map((r) => r.itemId),
    ),
  };
};

/** The frame with every pixel outside draftRegions() blacked out: what the worker sees when the page copies only
 *  those rectangles. */
const masked = (img: RGBImage): RGBImage => {
  const data = new Uint8ClampedArray(img.data.length);
  for (const r of draftRegions(img.width, img.height))
    for (let y = r.y; y < r.y + r.height; y++) {
      const a = (y * img.width + r.x) * 4;
      data.set(img.data.subarray(a, a + r.width * 4), a);
    }
  return { ...img, data };
};

const load = async (file: string, width?: number): Promise<RGBImage> => {
  let s = sharp(file).ensureAlpha();
  if (width) s = s.resize(width, Math.round((width * 9) / 16));
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data), channels: 4 };
};

describe('draftRegions', () => {
  // One case per frame, each at a different size (native / 1920 / 2560): the full cross product cost ~18 s.
  const cases: [string, number | undefined][] = [
    ['public/demo/choice1.png', undefined],
    ['public/demo/choice2.png', 1920],
    ['public/demo/choice1.png', 2560],
  ];
  for (const [file, width] of cases)
    it(`masking ${file}${width ? ` at ${width}px` : ''} to the regions changes no read`, async () => {
      const img = await load(file, width);
      const full = everything(img);
      expect(full.reads.filter((r) => r.present)).toHaveLength(3); // a real draft frame, not an empty one
      expect(full.labels.choice).toBeGreaterThan(0);
      expect(everything(masked(img))).toEqual(full);
    });

  it('covers a small part of the frame and stays inside it', () => {
    for (const [w, h] of [
      [1920, 1080],
      [2560, 1440],
      [2000, 1125],
    ] as const) {
      const rs = draftRegions(w, h);
      let px = 0;
      for (const r of rs) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(w);
        expect(r.y + r.height).toBeLessThanOrEqual(h);
        px += r.width * r.height;
      }
      expect(px / (w * h)).toBeLessThan(0.25);
    }
  });
});
