import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { probeShopScreen, type GrabRegion } from '../shopProbe';

/** A fake screen: `file` scaled to 1920x1080 and placed at (100, 50), served as BGRA the way GDI returns it. */
async function screenWith(file: string) {
  const { data, info } = await sharp(file).resize(1920, 1080).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return screenWithPixels(data, info.width, info.height);
}

function screenWithPixels(data: Uint8Array, width: number, height: number) {
  const game = { x: 100, y: 50, width, height };
  const grab: GrabRegion = (x, y, w, h) => {
    const out = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const s = ((y - game.y + j) * width + (x - game.x + i)) * 4;
        const d = (j * w + i) * 4;
        out[d] = data[s + 2]!; // B
        out[d + 1] = data[s + 1]!;
        out[d + 2] = data[s]!; // R
        out[d + 3] = 255;
      }
    return out;
  };
  return { game, grab };
}

async function preparationScreen(round = true, caption = true) {
  const overlays = [];
  if (round) overlays.push({ input: 'src/local/__tests__/assets/preparation-round1.png', left: 1745, top: 40 });
  if (caption) overlays.push({ input: 'src/local/__tests__/assets/round-countdown.png', left: 3000, top: 365 });
  const { data, info } = await sharp({ create: { width: 3439, height: 1439, channels: 4, background: '#000' } })
    .composite(overlays)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return screenWithPixels(data, info.width, info.height);
}

describe('probeShopScreen', () => {
  it('sees the draft screen from just the CHOICE glyph region, wherever the window sits on screen', async () => {
    for (const f of ['public/demo/choice1.png', 'public/demo/choice2.png']) {
      const { game, grab } = await screenWith(f);
      expect(probeShopScreen(game, grab)).toBe(true);
    }
  });

  it('does not fire on gameplay', async () => {
    const { game, grab } = await screenWith('public/demo/gameplay.png');
    expect(probeShopScreen(game, grab)).toBe(false);
  });

  it('starts capture after all picks only with the real ROUND 1 glyph and complete fixed countdown caption', async () => {
    const { game, grab } = await preparationScreen();
    let px = 0;
    expect(
      probeShopScreen(game, (x, y, w, h) => {
        expect(x).toBeGreaterThanOrEqual(game.x);
        expect(y).toBeGreaterThanOrEqual(game.y);
        expect(x + w).toBeLessThanOrEqual(game.x + game.width);
        expect(y + h).toBeLessThanOrEqual(game.y + game.height);
        px += w * h;
        return grab(x, y, w, h);
      }),
    ).toBe(true);
    expect(px / (game.width * game.height)).toBeLessThan(0.01);
    for (const [round, caption] of [
      [false, true],
      [true, false],
    ]) {
      const missing = await preparationScreen(round, caption);
      expect(probeShopScreen(missing.game, missing.grab)).toBe(false);
    }
  });

  it('rejects a later-round screen even when the same preparation caption is present', async () => {
    const width = 1920,
      height = 1080,
      s = height / 1439;
    const caption = await sharp('src/local/__tests__/assets/round-countdown.png')
      .resize(Math.round(420 * s), Math.round(70 * s))
      .toBuffer();
    const { data } = await sharp('public/demo/inround-r3.png')
      .resize(width, height)
      .ensureAlpha()
      .composite([{ input: caption, left: Math.round(width - 439 * s), top: Math.round(365 * s) }])
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { game, grab } = screenWithPixels(data, width, height);
    expect(probeShopScreen(game, grab)).toBe(false);
  });

  it('reads only a small region and is false when the grab fails', async () => {
    const { game, grab } = await screenWith('public/demo/choice1.png');
    let px = 0;
    probeShopScreen(game, (x, y, w, h) => {
      px = w * h;
      return grab(x, y, w, h);
    });
    expect(px).toBeGreaterThan(0);
    expect(px / (game.width * game.height)).toBeLessThan(0.01);
    expect(probeShopScreen(game, () => null)).toBe(false);
  });
});
