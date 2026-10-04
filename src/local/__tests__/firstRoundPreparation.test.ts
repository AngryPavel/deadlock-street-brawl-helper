import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FirstRoundPreparation, hasRoundCountdown, roundCountdownRegion } from '../firstRoundPreparation';
import type { RGBImage } from '../../brawl/recognise';

const fixture = 'src/local/__tests__/assets/round-countdown.png';
async function captionFrame(width = 3439, height = 1439, dx = 0, dy = 0): Promise<RGBImage> {
  const s = height / 1439;
  const { data, info } = await sharp(fixture)
    .resize(Math.round(420 * s), Math.round(70 * s))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    channels: info.channels as 4,
    data,
    origin: { x: Math.round(width - 439 * s) + dx, y: Math.round(365 * s) + dy, fullWidth: width, fullHeight: height },
  };
}

describe('fixed round preparation caption', () => {
  it('reads the real non-shop screenshot at ultrawide, 16:9 and height-scaled resolutions', async () => {
    for (const [w, h] of [
      [3439, 1439],
      [2560, 1440],
      [1920, 1080],
      [1600, 900],
      [3840, 2160],
    ])
      expect(hasRoundCountdown(await captionFrame(w, h)), `${w}x${h}`).toBe(true);
  });
  it('tolerates capture pixel offsets while staying anchored to the right edge', async () => {
    expect(hasRoundCountdown(await captionFrame(3439, 1439, 1, -1))).toBe(true);
    expect(hasRoundCountdown(await captionFrame(3439, 1439, -200))).toBe(false);
    const ultra = roundCountdownRegion(3439, 1439);
    const normal = roundCountdownRegion(2560, 1439);
    expect(ultra.x - normal.x).toBe(879);
    expect(ultra.width).toBe(normal.width);
  });
  it('rejects blank, solid tooltip ink, and the changing green seconds without the phrase', async () => {
    const image = await captionFrame();
    expect(hasRoundCountdown({ ...image, data: new Uint8Array(image.data.length) })).toBe(false);
    const cream = new Uint8Array(image.data.length);
    for (let i = 0; i < cream.length; i += 4) cream.set([210, 200, 175, 255], i);
    expect(hasRoundCountdown({ ...image, data: cream })).toBe(false);
    const seconds = Uint8Array.from(image.data);
    for (let i = 0; i < seconds.length; i += 4) if (seconds[i]! >= seconds[i + 1]!) seconds.fill(0, i, i + 3);
    expect(hasRoundCountdown({ ...image, data: seconds })).toBe(false);
  });
  it('rejects actual draft frames with no countdown label', async () => {
    for (const name of ['choice1', 'choice2', 'draft-r2c3-reroll', 'gameplay', 'inround-r3']) {
      const { data, info } = await sharp(`public/demo/${name}.png`).raw().toBuffer({ resolveWithObject: true });
      expect(
        hasRoundCountdown({ data, width: info.width, height: info.height, channels: info.channels as 4 }),
        name,
      ).toBe(false);
    }
  });
});

describe('first round preparation lifetime', () => {
  const draft = { shop: true, round: 1, countdown: false };
  const countdown = { shop: false, round: 1, countdown: true };
  const absent = { shop: false, round: 0, countdown: false };
  it('keeps team evidence through completed picks and hides after countdown disappears', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe(draft, 0)).toBe(true);
    expect(phase.observe(countdown, 11000)).toBe(true);
    expect(phase.observe(absent, 11300)).toBe(true);
    expect(phase.observe(absent, 11600)).toBe(false);
    expect(phase.observe(countdown, 12000)).toBe(false);
  });
  it('tolerates a brief tooltip/dropout, then ends on sustained blank or gameplay', () => {
    const phase = new FirstRoundPreparation();
    phase.observe(draft, 0);
    expect(phase.observe(absent, 100)).toBe(true);
    expect(phase.observe(draft, 250)).toBe(true);
    expect(phase.observe(countdown, 600)).toBe(true);
    expect(phase.observe(absent, 900)).toBe(true);
    expect(phase.observe(countdown, 1000)).toBe(true);
    expect(phase.observe(absent, 1600)).toBe(false);
  });
  it('suppresses later rounds and naked countdown, and resets for capture stop/new match', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe({ ...countdown, round: 0 }, 0)).toBe(false);
    expect(phase.observe(countdown, 10)).toBe(true); // F8 during preparation: real ROUND 1 and caption
    expect(phase.observe({ shop: true, round: 2, countdown: false, confirmedRound: true }, 20)).toBe(false);
    expect(phase.observe(draft, 30)).toBe(false);
    phase.reset();
    expect(phase.visible).toBe(false);
    expect(phase.observe(draft, 40)).toBe(true);
  });
  it('recovers from one contradictory raw ROUND glyph and ends only after two distinct consistent later-round samples', () => {
    const phase = new FirstRoundPreparation();
    expect(phase.observe({ ...countdown, sample: 1 }, 0)).toBe(true);
    expect(phase.observe({ ...countdown, round: 2, sample: 2 }, 100)).toBe(true);
    expect(phase.observe({ ...countdown, sample: 3 }, 200)).toBe(true);
    expect(phase.observe({ ...countdown, round: 2, sample: 4 }, 300)).toBe(true);
    expect(phase.observe({ ...countdown, round: 2, sample: 4 }, 400)).toBe(true); // duplicate delivery is not fresh evidence
    expect(phase.observe({ ...countdown, round: 2, sample: 5 }, 500)).toBe(false);
    expect(phase.observe({ ...countdown, sample: 6 }, 600)).toBe(false);
  });
});
