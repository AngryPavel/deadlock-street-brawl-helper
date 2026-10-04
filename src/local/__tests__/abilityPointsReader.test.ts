import { afterAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { AbilityPointsReader, abilityPointsRect, readAbilityPoints } from '../abilityPointsReader';
import type { RGBImage } from '../../brawl/recognise';
import { stopItemNameOCR } from '../cardNameOcr';

const img: RGBImage = { width: 1, height: 1, channels: 4, data: new Uint8Array(4) };
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
afterAll(stopItemNameOCR);

describe('available ability points', () => {
  it('requires two reads, holds through obstruction, and confirms the final zero', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const reader = new AbilityPointsReader(read),
      emit = vi.fn();
    for (let i = 0; i < 5; i++) {
      reader.poll(img, i * 1000, emit);
      await flush();
    }
    expect(emit.mock.calls.map(([n]) => n)).toEqual([6, 0]);
    expect(reader.value).toBe(0);
  });
  it('discards a result belonging to the preceding round', async () => {
    let resolve!: (n: number) => void;
    const reader = new AbilityPointsReader(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    const emit = vi.fn();
    reader.poll(img, 0, emit);
    reader.reset();
    resolve(6);
    await flush();
    expect(reader.value).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
  it('reads the actual ultrawide HUD zero instead of nearby ability hotkeys', async () => {
    for (const path of ['scripts/win/frames/ultrawide-choice3-zero.png', 'public/demo/inround-r3.png']) {
      const meta = await sharp(path).metadata();
      const r = abilityPointsRect(meta.width!, meta.height!);
      const { data, info } = await sharp(path)
        .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(await readAbilityPoints({ width: info.width, height: info.height, data, channels: 4 })).toBe(0);
    }
  }, 20_000);
  it('recognizes the lobby infinity and does not parse it as zero', async () => {
    const { data, info } = await sharp('scripts/win/frames/ability-points-infinity.png')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(await readAbilityPoints({ width: info.width, height: info.height, data, channels: 4 })).toBe('infinite');
  });
  it('reads positive one and two digit banks in either HUD color', async () => {
    for (const [text, color] of [
      ['6', '#68be94'],
      ['9', '#68be94'],
      ['8', '#c77df1'],
      ['1', '#68be94'],
      ['12', '#c77df1'],
      ['32', '#68be94'],
    ]) {
      const svg = `<svg width="65" height="38"><rect width="65" height="38" fill="#29201c"/><text x="0" y="30" font-family="Arial" font-weight="bold" font-size="28" fill="${color}">${text}</text></svg>`;
      const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const points = await readAbilityPoints({ width: info.width, height: info.height, data, channels: 4 });
      if (text === '9' || text === '8')
        expect(points).not.toBe(0); // Unread is preferable to a false zero.
      else expect(points).toBe(Number(text));
    }
  }, 20_000);
});
