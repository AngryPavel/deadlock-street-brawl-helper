import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeIconIndex, readDraftMeta, readDraftScreen, readRoundChoice } from '../../src/brawl/recognise';

// What the recogniser reads from the tracked demo frames: card ids, round/choice and the hero bar. The advice
// is a pure function of these, so pinning them proves speed work (warm-up, caching) never changes the advice.
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
const GOLDEN: Record<string, unknown> = {
  choice1: {
    rc: [1, 1],
    reads: ['1548066885', '2829638276', '3633614685'],
    self: 1,
    bar: [79, 1, 15, 64, 58, 6, 12, 35],
  },
  choice2: {
    rc: [1, 2],
    reads: ['4104549924', '1144549437', '1770441818'],
    self: 1,
    bar: [79, 1, 15, 64, 58, 6, 12, 35],
  },
  'draft-r1c2': {
    rc: [1, 2],
    reads: ['7409189', '3970837787', '876563814+'],
    self: 1,
    bar: [11, 1, 60, 63, 19, 67, 79, 52],
  },
  'draft-r2c1': {
    rc: [2, 1],
    reads: ['381961617', '1235347618', '395944548'],
    self: 1,
    bar: [11, 1, 60, 63, 19, 67, 79, 52],
  },
  'draft-r2c3-reroll': {
    rc: [2, 3],
    reads: ['3144988365', '1378931225', '2481177645'],
    self: 1,
    bar: [11, 1, 60, 63, 19, 67, 79, 52],
  },
};
const FRAMES = ['choice1', 'choice2', 'draft-r1c2', 'draft-r2c1', 'draft-r2c3-reroll'];

describe('recogniser reads on the demo frames', () => {
  it.each(FRAMES)('%s', async (name) => {
    const { data, info } = await sharp(`public/demo/${name}.png`)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img = { width: info.width, height: info.height, data, channels: 4 as const };
    const reads = readDraftScreen(img, index, () => 0).map(
      (r) => `${r.itemId}${r.enhanced ? '+' : ''}${r.rare ? 'r' : ''}`,
    );
    const meta = readDraftMeta(img, index);
    const rc = readRoundChoice(img);
    const bar = [...meta.bar.left, ...meta.bar.right].map((h) => h.heroId);
    const got = { rc: [rc.round, rc.choice], reads, self: meta.self, bar };
    expect(got).toEqual(GOLDEN[name]);
  });
});
