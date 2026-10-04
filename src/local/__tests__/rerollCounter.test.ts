import { describe, expect, it, vi, afterAll } from 'vitest';
import sharp from 'sharp';
import { readRerollsRemaining, terminateOCR } from '../../brawl/ocr';
import { RerollCounterReader } from '../rerollCounter';
import type { RGBImage } from '../../brawl/recognise';

const img = { width: 1, height: 1, data: new Uint8Array(4), channels: 4 } as RGBImage;
const context = { key: '1,2,3', round: 1, choice: 3 };
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
afterAll(terminateOCR);

describe('live reroll availability', () => {
  it('latches a positive count and reads only a changed label, confirming a decrement before unlocking', async () => {
    let label = 'one';
    const read = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const emit = vi.fn();
    const reader = new RerollCounterReader(read, () => label);
    reader.poll(img, context, 0, emit);
    await flush();
    expect(emit.mock.calls.map((args) => args[0])).toEqual([-1]);
    reader.poll(img, context, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(emit.mock.lastCall?.[0]).toBe(1);
    reader.poll(img, context, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    label = 'zero';
    reader.poll(img, context, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(1);
    reader.poll(img, context, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(emit.mock.lastCall?.[0]).toBe(0);
    expect(emit.mock.lastCall?.[2]).toBe(true);
  });
  it('discards an old asynchronous count even if a new choice offers the same items', async () => {
    let finish!: (value: number) => void;
    const read = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const emit = vi.fn();
    const reader = new RerollCounterReader(read, () => 'one');
    reader.poll(img, context, 0, emit);
    reader.poll(img, { ...context, choice: 1 }, 10, emit);
    finish(1);
    await flush();
    expect(emit.mock.calls.every((args) => args[0] === -1)).toBe(true);
  });
  it('keeps the counter across an unreadable tooltip and an ordinary item selection', async () => {
    let label: string | null = 'one';
    const read = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(-1);
    const emit = vi.fn();
    const reader = new RerollCounterReader(read, () => label);
    reader.poll(img, { ...context, choice: 1 }, 0, emit);
    await flush();
    reader.poll(img, { ...context, choice: 1 }, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    label = null;
    reader.poll(img, { ...context, choice: 1 }, Number.MAX_SAFE_INTEGER, emit);
    expect(reader.value).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    label = 'tooltip';
    reader.poll(img, { ...context, choice: 1 }, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(1);
    label = 'one';
    read.mockResolvedValue(1);
    reader.poll(img, { ...context, choice: 2, key: '4,5,6' }, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(1);
    expect(emit.mock.lastCall?.[0]).toBe(1);
  });
  it('blocks a same-choice reroll until its new count is read, and restores one in the next round', async () => {
    const read = vi.fn().mockResolvedValue(1);
    const emit = vi.fn();
    const reader = new RerollCounterReader(read, () => 'label');
    reader.poll(img, context, 0, emit);
    await flush();
    reader.poll(img, context, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(1);
    read.mockResolvedValue(0);
    const rerolled = { ...context, key: '4,5,6' };
    reader.poll(img, rerolled, Number.MAX_SAFE_INTEGER, emit);
    expect(reader.value).toBeNull();
    await flush();
    expect(reader.value).toBe(0);
    read.mockResolvedValue(1);
    const nextRound = { key: '7,8,9', round: 2, choice: 1 };
    reader.poll(img, nextRound, Number.MAX_SAFE_INTEGER, emit);
    expect(reader.value).toBeNull();
    await flush();
    reader.poll(img, nextRound, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(1);
  });
  it('does not invent an extra reroll within a round but handles an unreadable next-round label', async () => {
    let label = 'zero';
    const read = vi.fn().mockResolvedValue(0);
    const reader = new RerollCounterReader(read, () => label);
    const emit = vi.fn();
    reader.poll(img, context, 0, emit);
    await flush();
    expect(reader.value).toBe(0);
    label = 'one';
    read.mockResolvedValue(1);
    reader.poll(img, context, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(0);
    const wrapped = { key: '4,5,6', round: 0, choice: 1 };
    reader.poll(img, wrapped, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    reader.poll(img, wrapped, Number.MAX_SAFE_INTEGER, emit);
    await flush();
    expect(reader.value).toBe(1);
    expect(emit.mock.lastCall?.[1].round).toBe(2);
  });
  it('reads exactly zero on the user screenshot with the flashing enhanced Indomitable', async () => {
    const { data, info } = await sharp('scripts/win/frames/ultrawide-choice3-zero.png')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(await readRerollsRemaining({ width: info.width, height: info.height, data, channels: 4 })).toBe(0);
  }, 20_000);
});
