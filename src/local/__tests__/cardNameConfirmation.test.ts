import { describe, expect, it, vi } from 'vitest';
import { CardNameConfirmation, exactCardNameId } from '../cardNameConfirmation';
import type { CardRead, RGBImage } from '../../brawl/recognise';
import { cardAnchors } from '../../brawl/recognise';
import { cardNameRegions } from '../cardNames';

const names = { 1: 'Superior Duration', 2: 'Tankbuster', 3: "Enchanter's Emblem" };
const img: RGBImage = { width: 2560, height: 1440, channels: 4, data: new Uint8ClampedArray(2560 * 1440 * 4) };
const reads = [1, 2, 3].map((itemId) => ({ itemId, present: true })) as CardRead[];
describe('independent names for late correction', () => {
  const softImage = () => {
    const data = new Uint8ClampedArray(img.data.length);
    const band = cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height))[1]!;
    for (let y = 10; y < 20; y++)
      for (let x = 10; x < 30; x++) {
        const i = ((band.y + y) * img.width + band.x + x) * 4;
        data.set([x === 10 ? 140 : 220, x === 10 ? 140 : 220, x === 10 ? 140 : 220, 255], i);
      }
    return { ...img, data };
  };
  it.each([
    { text: 'Tankbxxxter', confidence: 99 },
    { text: '', confidence: 79 },
  ])('makes one alternate pass for incomplete or distant OCR: %j', async (first) => {
    const source = softImage();
    const text = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({ text: 'Tankbuster', confidence: 94 });
    const proof = new CardNameConfirmation(text);
    expect(await proof.confirm(source, reads, names, 'retry', [true, false, true])).toBe(true);
    expect(text).toHaveBeenCalledTimes(2);
    expect(text.mock.calls[1]![0]).toMatchObject({ scale: 4, interpolation: 'nearest' });
    const copied = text.mock.calls[1]![0].data as Uint8Array;
    expect(copied.some((v) => v > 0 && v < 255)).toBe(true);
    expect(await proof.confirm(source, reads, names, 'retry', [true, false, true])).toBe(true);
    expect(text).toHaveBeenCalledTimes(2);
  });
  it('keeps two failed preprocessing attempts unknown and does not retry a service error', async () => {
    const text = vi.fn().mockResolvedValue({ text: 'Tankbxxxter', confidence: 99 });
    const proof = new CardNameConfirmation(text);
    expect(await proof.confirm(softImage(), reads, names, 'failed', [true, false, true])).toBe(false);
    expect(text).toHaveBeenCalledTimes(2);
    text.mockRejectedValue(new Error('OCR timed out'));
    expect(await proof.confirm(softImage(), reads, names, 'service-error', [true, false, true])).toBe(false);
    expect(text).toHaveBeenCalledTimes(3);
  });
  it('invalidates cached evidence when antialiased pixels change without changing the binary mask', async () => {
    const text = vi.fn().mockResolvedValue({ text: 'Tankbuster', confidence: 94 });
    const proof = new CardNameConfirmation(text);
    const source = softImage();
    expect(await proof.confirm(source, reads, names, 'pixels', [true, false, true])).toBe(true);
    expect(await proof.confirm(source, reads, names, 'pixels', [true, false, true])).toBe(true);
    expect(text).toHaveBeenCalledTimes(1);
    for (let i = 0; i < source.data.length; i++) if (source.data[i] === 140) source.data[i] = 145;
    expect(await proof.confirm(source, reads, names, 'pixels', [true, false, true])).toBe(true);
    expect(text).toHaveBeenCalledTimes(2);
  });
  it('copies alternate pixels before awaiting even if the source frame is overwritten', async () => {
    let finish!: (value: { text: string; confidence: number }) => void;
    const text = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ text: 'Tankbuster', confidence: 94 });
    const proof = new CardNameConfirmation(text);
    const source = softImage();
    const pending = proof.confirm(source, reads, names, 'copied', [true, false, true]);
    source.data.fill(0);
    finish({ text: 'Tankbxxxter', confidence: 99 });
    expect(await pending).toBe(true);
    expect((text.mock.calls[1]![0].data as Uint8Array).some((v) => v > 0 && v < 255)).toBe(true);
  });
  it('prevents a stale reset from starting its alternate preprocessing retry', async () => {
    let finish!: (value: { text: string; confidence: number }) => void;
    const text = vi.fn(
      () =>
        new Promise<{ text: string; confidence: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const proof = new CardNameConfirmation(text);
    const source = softImage();
    const pending = proof.confirm(source, reads, names, 'stale', [true, false, true]);
    source.data.fill(0);
    proof.reset();
    finish({ text: 'Tankbxxxter', confidence: 99 });
    expect(await pending).toBe(false);
    expect(text).toHaveBeenCalledTimes(1);
  });
  it('matches exact unique normalized text regardless of reported confidence', () => {
    expect(exactCardNameId('superior duration', 96, names)).toBe(1);
    expect(exactCardNameId('Tankbuzter', 99, names)).toBe(0);
    expect(exactCardNameId('Tankbuster', 79, names)).toBe(2);
    expect(exactCardNameId('Tankbuster', 0, names)).toBe(2);
    expect(exactCardNameId('Tankbuster', NaN, names)).toBe(2);
    expect(exactCardNameId('ENCHANTERS EMBLEM', 94, names)).toBe(3);
    expect(exactCardNameId('Tankbuster', 99, { ...names, 4: 'TANK-BUSTER' })).toBe(0);
  });
  it('requires all three names to agree with raw slot IDs, caches unchanged evidence, and never mutates reads', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ text: 'Superior Duration', confidence: 96 })
      .mockResolvedValueOnce({ text: 'Tankbuster', confidence: 89 })
      .mockResolvedValueOnce({ text: "Enchanter's Emblem", confidence: 94 });
    const confirmation = new CardNameConfirmation(read);
    expect(await confirmation.confirm(img, reads, names, 'candidate1')).toBe(true);
    expect(await confirmation.confirm(img, reads, names, 'candidate1')).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    read.mockResolvedValue({ text: 'Tankbuster', confidence: 95 });
    expect(await confirmation.confirm(img, reads, names, 'candidate2')).toBe(false);
    expect(read).toHaveBeenCalledTimes(6);
  });
  it.each([0, 34, 78, NaN])(
    'accepts an exact primary name at confidence %s without another OCR pass',
    async (confidence) => {
      const text = vi.fn().mockResolvedValue({ text: 'Tankbuster', confidence });
      const proof = new CardNameConfirmation(text);
      expect(await proof.confirm(softImage(), reads, names, 'exact', [true, false, true])).toBe(true);
      expect(text).toHaveBeenCalledTimes(1);
      expect(proof.getOutcome('exact')?.slots[1]).toMatchObject({ status: 'exact', itemId: 2 });
    },
  );
  it('corrects a distinctive typo even when the weak raw ID differs, and invalidates changed catalogue evidence', async () => {
    const text = vi.fn().mockResolvedValue({ text: 'Tankbuzter', confidence: 0 });
    const proof = new CardNameConfirmation(text);
    const mixed = reads.map((read, slot) => (slot === 1 ? { ...read, itemId: 1 } : read));
    expect((await proof.resolve(img, mixed, names, {}, 'catalog', [true, false, true]))?.[1]?.itemId).toBe(2);
    expect(
      await proof.resolve(img, mixed, { ...names, 4: 'Tankbaster' }, {}, 'catalog', [true, false, true]),
    ).toBeNull();
    expect(text).toHaveBeenCalledTimes(2);
  });
  it('discards an asynchronous confirmation after a capture reset', async () => {
    const resolvers: ((value: { text: string; confidence: number }) => void)[] = [];
    const confirmation = new CardNameConfirmation(() => new Promise((resolve) => resolvers.push(resolve)));
    const pending = confirmation.confirm(img, reads, names, 'candidate1');
    confirmation.reset();
    Object.values(names).forEach((text, slot) => resolvers[slot]!({ text, confidence: 95 }));
    expect(await pending).toBe(false);
    expect(confirmation.getOutcome('candidate1')).toBeNull();
  });
  it('publishes only the current evidence and keeps a same-pixel outcome while its cached promise resolves', async () => {
    const finish: ((value: { text: string; confidence: number }) => void)[] = [];
    const text = vi.fn(() => new Promise<{ text: string; confidence: number }>((resolve) => finish.push(resolve)));
    const proof = new CardNameConfirmation(text);
    const source = softImage();
    const old = proof.confirm(source, reads, names, 'old', [true, false, true]);
    const latest = proof.confirm(source, reads, names, 'latest', [true, false, true]);
    finish[1]!({ text: 'Tankbuster', confidence: 94 });
    expect(await latest).toBe(true);
    const current = proof.getOutcome('latest');
    finish[0]!({ text: 'Tankbuster', confidence: 94 });
    expect(await old).toBe(true);
    expect(proof.getOutcome('old')).toBeNull();
    expect(proof.getOutcome('latest')).toBe(current);
    const cached = proof.confirm(source, reads, names, 'latest', [true, false, true]);
    expect(proof.getOutcome('latest')).toBe(current);
    expect(await cached).toBe(true);
    expect(text).toHaveBeenCalledTimes(2);
    const band = cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height))[1]!;
    source.data.set([145, 145, 145, 255], ((band.y + 10) * img.width + band.x + 10) * 4);
    const changed = proof.confirm(source, reads, names, 'latest', [true, false, true]);
    expect(proof.getOutcome('latest')).toBeNull();
    finish[2]!({ text: 'Tankbuster', confidence: 94 });
    expect(await changed).toBe(true);
  });
  it('corroborates each raw slot with a distinctive typo while strong neighbors never use OCR', async () => {
    const mixed = reads.map((r, slot) => ({
      ...r,
      match: { itemId: r.itemId, score: slot === 1 ? 0.6 : 0.98, margin: slot === 1 ? 0.004 : 0.3 },
    })) as CardRead[];
    const text = vi.fn().mockResolvedValue({ text: 'Tankbuster', confidence: 93 });
    const proof = new CardNameConfirmation(text);
    expect(await proof.confirm(img, mixed, names, 'exact')).toBe(true);
    expect(text).toHaveBeenCalledTimes(1); // Strong neighbors never suffer an unrelated OCR typo.
    text.mockResolvedValue({ text: 'Tankbuzter', confidence: 99 });
    expect(await proof.confirm(img, mixed, names, 'typo')).toBe(true);
    expect(proof.getOutcome('typo')?.slots[1]).toMatchObject({ status: 'corrected', itemId: 2 });
    text.mockResolvedValue({ text: 'Superior Duration', confidence: 99 });
    expect(await proof.confirm(img, mixed, names, 'swapped')).toBe(false);
    expect(mixed.map((r) => r.itemId)).toEqual([1, 2, 3]);
  });
  it('keeps completed unknown evidence finite until reset while retaining successful evidence', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const text = vi.fn().mockResolvedValue({ text: '', confidence: 0 });
      const proof = new CardNameConfirmation(text);
      expect(await proof.confirm(img, reads, names, 'same')).toBe(false);
      expect(await proof.confirm(img, reads, names, 'same')).toBe(false);
      expect(text).toHaveBeenCalledTimes(3);
      now = 1001;
      expect(await proof.confirm(img, reads, names, 'same')).toBe(false);
      expect(text).toHaveBeenCalledTimes(3);
      expect(proof.getOutcome('same')?.slots.map((slot) => [slot.status, slot.reason])).toEqual([
        ['unknown', 'empty-text'],
        ['unknown', 'empty-text'],
        ['unknown', 'empty-text'],
      ]);
      proof.reset();
      expect(proof.getOutcome('same')).toBeNull();
      text
        .mockResolvedValueOnce({ text: 'Superior Duration', confidence: 96 })
        .mockResolvedValueOnce({ text: 'Tankbuster', confidence: 89 })
        .mockResolvedValueOnce({ text: "Enchanter's Emblem", confidence: 94 });
      expect(await proof.confirm(img, reads, names, 'same')).toBe(true);
      now = 10_000;
      expect(await proof.confirm(img, reads, names, 'same')).toBe(true);
      expect(text).toHaveBeenCalledTimes(6);
    } finally {
      clock.mockRestore();
    }
  });
  it('retries only unavailable OCR after bounded service backoff and publishes exact slot evidence', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const text = vi
        .fn()
        .mockRejectedValueOnce(new Error('OCR failed'))
        .mockResolvedValue({ text: 'Tankbuster', confidence: 94 });
      const proof = new CardNameConfirmation(text);
      const source = softImage();
      expect(await proof.confirm(source, reads, names, 'service', [true, false, true])).toBe(false);
      expect(proof.getOutcome('service')?.slots.map((slot) => slot.status)).toEqual([
        'strong',
        'unavailable',
        'strong',
      ]);
      now = 999;
      expect(await proof.confirm(source, reads, names, 'service', [true, false, true])).toBe(false);
      expect(text).toHaveBeenCalledTimes(1);
      now = 1001;
      expect(await proof.confirm(source, reads, names, 'service', [true, false, true])).toBe(true);
      expect(text).toHaveBeenCalledTimes(2);
      expect(proof.getOutcome('service')?.slots[1]).toMatchObject({
        slot: 1,
        status: 'exact',
        itemId: 2,
        primary: { text: 'Tankbuster', confidence: 94 },
      });
      expect(proof.getOutcome('service')?.slots[1]?.primary?.cropSignature).toEqual(expect.any(String));
    } finally {
      clock.mockRestore();
    }
  });
  it('reuses each completed weak slot when neighboring pixels change', async () => {
    const text = vi.fn().mockResolvedValue({ text: 'Tankbxxxter', confidence: 99 });
    const proof = new CardNameConfirmation(text);
    const source = softImage();
    expect(await proof.confirm(source, reads, names, 'neighbors', [true, false, true])).toBe(false);
    expect(text).toHaveBeenCalledTimes(2);
    const first = proof.getOutcome('neighbors')!;
    const band = cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height))[0]!;
    source.data.set([220, 220, 220, 255], (band.y * img.width + band.x) * 4);
    expect(await proof.confirm(source, reads, names, 'neighbors', [true, false, true])).toBe(false);
    expect(text).toHaveBeenCalledTimes(2);
    const next = proof.getOutcome('neighbors')!;
    expect(next.evidenceKey).not.toBe(first.evidenceKey);
    expect(next.slots[1]).toBe(first.slots[1]);
    expect(next.slots[1]).toMatchObject({
      status: 'unknown',
      reason: 'non-exact-name',
      primary: { text: 'Tankbxxxter' },
      alternate: { text: 'Tankbxxxter' },
    });
    expect(Object.isFrozen(next.slots[1])).toBe(true);
    expect(proof.getOutcome('other')).toBeNull();
  });
  it('replaces only a weak present ID with a complete name, preserving its raw uncertainty', async () => {
    const mixed = reads.map((r, slot) => ({
      ...r,
      match: { itemId: r.itemId, score: slot === 1 ? 0.56 : 0.99, margin: slot === 1 ? 0.004 : 0.3 },
    })) as CardRead[];
    const text = vi.fn().mockResolvedValue({ text: "Enchanter's Emblem", confidence: 95 });
    const proof = new CardNameConfirmation(text);
    const resolved = await proof.resolve(img, mixed, names, { 3: 4 }, 'correct');
    expect(resolved?.map((r) => r.itemId)).toEqual([1, 3, 3]);
    expect(resolved?.[1]).toMatchObject({ tier: 4, match: { itemId: 3, score: 0.56, margin: 0.004 } });
    expect(resolved?.[0]).toBe(mixed[0]);
    expect(resolved?.[2]).toBe(mixed[2]);
    expect(mixed.map((r) => r.itemId)).toEqual([1, 2, 3]);
    expect(await proof.confirm(img, mixed, names, 'correct')).toBe(false);
    expect(text).toHaveBeenCalledTimes(1);
    for (const evidence of [
      { text: 'Enchzzzter Emblem', confidence: 99 },
      { text: '', confidence: 99 },
    ]) {
      text.mockResolvedValue(evidence);
      expect(await proof.resolve(img, mixed, names, {}, JSON.stringify(evidence))).toBeNull();
    }
    text.mockClear();
    expect(
      await proof.resolve(
        img,
        mixed.map((r, slot) => ({ ...r, present: slot !== 1 })),
        names,
        {},
        'absent',
      ),
    ).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });
});
