import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { draftRegions, inventoryRegions, HERO_BAR, hudLayout, type CardRead } from '../recognise';
import type { FrameRegion, FrameResult, WorkerIn, WorkerOut } from '../worker';
import type { IconIndex } from '../types';
import { MatchMemory } from '../../local/matchMemory';
import { items, itemByName } from './testData';
import { cardNameRegions } from '../../local/cardNames';
import { cardAnchors } from '../recognise';
import { stopItemNameOCR } from '../../local/cardNameOcr';

const state = vi.hoisted(() => ({
  self: 1,
  selfSide: 'left' as 'left' | 'right',
  selfSlot: 0,
  selfReader: vi.fn(),
  round: 3,
  choice: 1,
  rerolls: 1,
  spent: false,
  inventory: [] as number[],
  foes: [2, 3, 4, 5],
  team: [1],
  cards: [101, 102, 103],
  actualLabels: false,
  actualCards: false,
  actualSelf: false,
  cardScore: 0.99,
  cardScores: [] as number[],
  visible: 3,
  actualNameOcr: false,
  nameReads: vi.fn(),
  inventoryReader: vi.fn(),
  cardReader: vi.fn(),
  metadataReader: vi.fn(),
}));
vi.mock('../recognise', async (original) => {
  const actual = await original<typeof import('../recognise')>();
  return {
    ...actual,
    decodeIconIndex: actual.decodeIconIndex,
    readRoundChoice: (img: import('../recognise').RGBImage) =>
      state.actualLabels ? actual.readRoundChoice(img) : { round: state.round, choice: state.choice },
    readPlayerHero: (img: import('../recognise').RGBImage, index: import('../recognise').DecodedIndex) => {
      state.selfReader();
      if (state.actualSelf) return actual.readPlayerHero(img, index);
      return state.self ? { heroId: state.self, side: state.selfSide, slot: state.selfSlot } : null;
    },
    readInventory: () => {
      state.inventoryReader();
      return state.inventory.map((itemId, slot) => ({ itemId, slot }));
    },
    readDraftScreen: (
      img: import('../recognise').RGBImage,
      index: import('../recognise').DecodedIndex,
      tierOf: (id: number) => number,
    ) => {
      state.cardReader();
      if (state.actualCards) return actual.readDraftScreen(img, index, tierOf);
      return state.cards.map((itemId, slot) => ({
        itemId,
        present: slot < state.visible,
        enhanced: false,
        match: { itemId, score: state.cardScores[slot] ?? state.cardScore, margin: 0.3 },
      })) as CardRead[];
    },
    readDraftMeta: (...args: Parameters<typeof actual.readDraftMeta>) => {
      state.metadataReader();
      if (state.actualSelf) return actual.readDraftMeta(...args);
      return {
        round: state.round,
        choice: state.choice,
        self: state.self,
        bar: { left: state.team.map((heroId) => ({ heroId })), right: state.foes.map((heroId) => ({ heroId })) },
        rerollsRemaining: -1,
      };
    },
  };
});
vi.mock('../ocr', () => ({ warmOCR: vi.fn(), terminateOCR: vi.fn() }));
vi.mock('../../local/cardNameOcr', async (original) => {
  const actual = await original<typeof import('../../local/cardNameOcr')>();
  return {
    ...actual,
    readItemName: (...args: Parameters<typeof actual.readItemName>) => {
      const injected = state.nameReads(...args);
      if (injected !== undefined) return injected;
      return state.actualNameOcr ? actual.readItemName(...args) : Promise.resolve({ text: '', confidence: 0 });
    },
  };
});
vi.mock('../../local/rerollCounter', () => ({
  RerollCounterReader: class {
    value: number | null = null;
    reset() {
      this.value = null;
    }
    poll(_: unknown, ctx: unknown, _now: number, emit: (value: number, ctx: unknown, spent: boolean) => void) {
      this.value = state.rerolls;
      if (state.spent) {
        state.spent = false;
        emit(this.value, ctx, true);
      }
    }
  },
}));

let handle: (ev: MessageEvent<WorkerIn>) => Promise<void>;
let outputs: WorkerOut[];
let regions: FrameRegion[];
let frameWidth = 2560,
  frameHeight = 1440;
const frame = async (elapsed = 250) => {
  vi.advanceTimersByTime(elapsed);
  const before = outputs.length;
  await handle({
    data: { type: 'frame', width: frameWidth, height: frameHeight, regions, prefer: [] },
  } as unknown as MessageEvent<WorkerIn>);
  return outputs
    .slice(before)
    .filter((m): m is FrameResult => m.type === 'result')
    .at(-1)!;
};
const actualCardPixels = async (
  name:
    | 'choice2'
    | 'choice3'
    | 'round1-choice3'
    | 'round2-choice2'
    | 'round2-choice3'
    | 'round3-choice2'
    | 'round3-choice3'
    | 'round4-choice3',
) => {
  const spec = JSON.parse(readFileSync(`src/brawl/__tests__/assets/settled-${name}.json`, 'utf8')) as {
    width: number;
    height: number;
    regions: (FrameRegion & { top: number })[];
  };
  frameWidth = spec.width;
  frameHeight = spec.height;
  regions = await Promise.all(
    spec.regions.map(async (r) => ({
      ...r,
      buffer: new Uint8Array(
        await sharp(`src/brawl/__tests__/assets/settled-${name}.webp`)
          .extract({ left: 0, top: r.top, width: r.width, height: r.height })
          .ensureAlpha()
          .raw()
          .toBuffer(),
      ).buffer,
    })),
  );
  if (name === 'choice2' || name === 'choice3') namePixels(true);
};
const namePixels = (visible: boolean, slot?: number) => {
  const bands = cardNameRegions(frameWidth, frameHeight, cardAnchors(frameWidth, frameHeight));
  for (const [i, band] of bands.entries()) {
    if (slot !== undefined && slot !== i) continue;
    let region = regions.find(
      (r) => r.x === band.x && r.y === band.y && r.width === band.width && r.height === band.height,
    );
    if (!region) {
      region = { ...band, buffer: new ArrayBuffer(band.width * band.height * 4) };
      regions.push(region);
    }
    const pixels = new Uint8Array(region.buffer);
    pixels.fill(0);
    if (visible) pixels.set([220, 220, 220, 255]);
  }
};
const accept = async () => {
  for (let i = 0; i < 10; i++) {
    const r = await frame();
    if (r.accepted) return r;
  }
  throw new Error('Offer never settled');
};
const inventoryPixels = (value: number) => {
  const inventory = inventoryRegions(2560, 1440)[0]!;
  const region = regions.find((r) => r.x === inventory.x && r.y === inventory.y)!;
  new Uint8Array(region.buffer).fill(value);
};
const rosterPixels = (value: number) => {
  const region = regions.find((r) => r.y === 0)!;
  new Uint8Array(region.buffer).fill(value);
};
const cardPixels = (value: number) => {
  for (const region of regions.filter((r) => r.y > 300 && r.height > 100 && r.y < 800))
    new Uint8Array(region.buffer).fill(value);
};
const closeDraft = async () => {
  state.choice = 0;
  await frame();
  vi.advanceTimersByTime(300);
  await frame();
  state.choice = 1;
};
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  state.self = 1;
  state.selfSide = 'left';
  state.selfSlot = 0;
  state.selfReader.mockClear();
  state.round = 3;
  state.choice = 1;
  state.rerolls = 1;
  state.spent = false;
  state.inventory = [itemByName('Extra Stamina').id];
  state.foes = [2, 3, 4, 5];
  state.team = [1];
  state.cards = [101, 102, 103];
  state.actualLabels = false;
  state.actualCards = false;
  state.actualSelf = false;
  state.cardScore = 0.99;
  state.cardScores = [];
  state.visible = 3;
  state.actualNameOcr = false;
  state.nameReads.mockReset();
  state.inventoryReader.mockClear();
  state.cardReader.mockClear();
  state.metadataReader.mockClear();
  outputs = [];
  frameWidth = 2560;
  frameHeight = 1440;
  regions = draftRegions(2560, 1440).map((r) => ({ ...r, buffer: new ArrayBuffer(r.width * r.height * 4) }));
  namePixels(true);
  vi.stubGlobal('self', {
    addEventListener: (_: string, listener: typeof handle) => {
      handle = listener;
    },
    postMessage: (message: WorkerOut) => outputs.push(message),
  });
  await import('../worker');
  await handle({
    data: {
      type: 'init',
      index: {
        ...JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')),
        names: Object.fromEntries(items.map((i) => [i.id, i.name])),
      } as IconIndex,
      tiers: Object.fromEntries(items.map((i) => [i.id, i.item_tier])),
      intervalMs: 100,
    },
  } as MessageEvent<WorkerIn>);
});
afterEach(async () => {
  await stopItemNameOCR();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worker confirmed state', () => {
  it('atomically retains exact corrected IDs after an initial name failure on identical pixels', async () => {
    const wrong = itemByName('Extra Spirit').id;
    const correct = itemByName('Quicksilver Reload').id;
    state.cards = [itemByName('Swift Striker').id, wrong, itemByName('Spirit Shielding').id];
    state.cardScores = [0.99, 0.6, 0.99];
    state.nameReads
      .mockResolvedValueOnce({ text: '', confidence: 0 })
      .mockResolvedValue({ text: 'Quicksilver Reload', confidence: 95 });
    expect(await frame()).toMatchObject({ accepted: false, key: '', reads: [] });
    expect(await frame(1001)).toMatchObject({ accepted: false, key: '', reads: [] });
    const committed = await accept();
    expect(committed.key).toBe(`${state.cards[0]},${correct},${state.cards[2]}`);
    expect(committed.reads[1]).toMatchObject({ itemId: correct, match: { itemId: correct, score: 0.6 } });
    const anchor = { ...committed.reads[1]!.match };
    expect(state.cardReader).toHaveBeenCalledTimes(1); // all retry frames reuse the original pixel anchor
    expect(state.nameReads).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 3; i++) {
      const next = await frame();
      expect(next.key).toBe(committed.key);
      expect(next.reads[1]!.match).toEqual(anchor);
    }
    expect(state.cardReader).toHaveBeenCalledTimes(1);
    expect(state.nameReads).toHaveBeenCalledTimes(2);
  });
  it('confirms real Paige before a weak card can qualify, and publishes only player metadata', async () => {
    state.actualLabels = state.actualCards = state.actualSelf = true;
    state.actualNameOcr = false; // exact weak-slot text remains unavailable, so this offer cannot be accepted
    await actualCardPixels('round2-choice2');
    await frame(500);
    expect(outputs.some((m) => m.type === 'result' && m.identityOnly)).toBe(false);
    await frame(500);
    const identities = outputs.filter((m): m is FrameResult => m.type === 'result' && !!m.identityOnly);
    expect(identities.at(-1)).toMatchObject({
      accepted: false,
      pending: true,
      shop: true,
      round: 2,
      choice: 2,
      key: '',
      reads: [],
      meta: { self: 67 },
    });
    expect(outputs.filter((m) => m.type === 'result' && m.accepted)).toEqual([]);
    await frame(500);
    const followup = outputs.filter((m): m is FrameResult => m.type === 'result' && !!m.identityOnly).at(-1)!;
    expect(followup.meta?.self).toBe(67);
    expect(followup.metadataSample).toBeGreaterThan(identities.at(-1)!.metadataSample!);
    expect(state.selfReader).toHaveBeenCalledTimes(2); // confirmed portraits use the normal slow follow-up cadence
    expect(outputs.filter((m) => m.type === 'result' && m.accepted)).toEqual([]);
  });
  it('rejects old capture frames and probes arriving after a new forced reset', async () => {
    await handle({ data: { type: 'reset', captureEpoch: 7 } } as MessageEvent<WorkerIn>);
    const before = outputs.length;
    await handle({
      data: { type: 'frame', captureEpoch: 6, width: frameWidth, height: frameHeight, regions, prefer: [] },
    } as unknown as MessageEvent<WorkerIn>);
    await handle({
      data: {
        type: 'probe',
        captureEpoch: 6,
        frameW: frameWidth,
        frameH: frameHeight,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        buffer: new ArrayBuffer(4),
      },
    } as MessageEvent<WorkerIn>);
    expect(outputs).toHaveLength(before);
    expect(state.cardReader).not.toHaveBeenCalled();
    const fresh = await accept();
    expect(fresh.captureEpoch).toBe(7);
  });
  it('does not adopt the first wrong player read, then confirms fresh Graves without an offer change', async () => {
    state.self = 67;
    state.team = [67, 10, 11, 12];
    await frame(); // one wrong portrait observation must not be adopted
    expect(outputs.some((m) => m.type === 'result' && m.identityOnly)).toBe(false);
    state.self = 76;
    state.selfSlot = 2;
    state.team = [10, 11, 76, 12];
    const first = await accept();
    expect(first.meta?.self).toBe(0);
    state.self = 76;
    state.selfSlot = 2;
    state.team = [10, 11, 76, 12];
    expect((await frame()).meta?.self).toBe(0);
    const confirmed = await accept();
    expect(confirmed).toMatchObject({ accepted: true, transition: 'metadata', key: first.key });
    expect(confirmed.meta?.self).toBe(76);
    expect(confirmed.meta?.rerollsRemaining).toBe(1);
    expect(state.selfReader.mock.calls.length).toBeGreaterThan(0);
  });
  it('periodically corrects confirmed hero and side on unchanged frames without erasing match acquisitions', async () => {
    state.round = 4;
    state.self = 67;
    state.team = [67, 10, 11, 12];
    const initial = await accept();
    await frame();
    const memory = new MatchMemory();
    memory.observeRoster(67, state.foes, 4);
    memory.observeRoster(67, state.foes, 4);
    memory.observeInventory(state.inventory, items, 10);
    state.self = 76;
    state.selfSlot = 2;
    state.team = [10, 11, 76, 12];
    expect((await frame(5000)).meta?.self).toBe(67);
    const corrected = await frame(500);
    expect(corrected).toMatchObject({ accepted: true, transition: 'hero', key: initial.key });
    expect(corrected.meta?.self).toBe(76);
    expect(corrected.meta?.rerollsRemaining).toBe(1);
    expect(memory.observeRoster(76, state.foes, 4, true).newMatch).toBe(false);
    state.self = 67;
    expect((await frame(5000)).meta?.self).toBe(76);
    state.self = 0;
    expect((await frame(500)).meta?.self).toBe(76);
    state.self = 76;
    state.selfSide = 'right';
    state.foes = [2, 3, 76, 5];
    state.team = [67, 10, 11, 12];
    await frame(500);
    const sideCorrection = await frame(500);
    expect(sideCorrection.transition).toBe('hero');
    expect(memory.observeRoster(76, state.team, 4, true).newMatch).toBe(false);
    expect(memory.enemies).toEqual([10, 11, 12, 67]);
    expect(memory.owned).toEqual(state.inventory);
    expect(memory.acquisitions).toHaveLength(1);
    state.choice = 2;
    expect((await accept()).meta?.self).toBe(76); // The next offer must not replay the previous cached Paige.
  });
  it.each([undefined, 1])('keeps new offers pending when all or one name band is empty (slot=%s)', async (slot) => {
    namePixels(false, slot);
    for (let i = 0; i < 5; i++) expect(await frame()).toMatchObject({ accepted: false, key: '', reads: [] });
    expect(state.nameReads).not.toHaveBeenCalled();
    namePixels(true);
    const first = await accept();
    namePixels(false, 2);
    expect((await frame()).key).toBe(first.key); // A tooltip over a settled name does not clear it.
    state.choice = 2;
    state.cards = [201, 202, 203];
    cardPixels(255);
    for (let i = 0; i < 5; i++) expect((await frame()).accepted).toBe(false);
    namePixels(true);
    expect(await accept()).toMatchObject({ accepted: true, choice: 2, key: '201,202,203' });
  });
  it.each([false, true])(
    'anchors gradual +10 core motion even when unrelated HUD forces raw rereads=%s',
    async (forceRead) => {
      await accept();
      state.choice = 2;
      state.cards = [201, 202, 203];
      const before = state.cardReader.mock.calls.length;
      for (let value = 10; value <= 240; value += 10) {
        cardPixels(value);
        if (forceRead) rosterPixels(value % 20 ? 255 : 0);
        expect((await frame(100)).accepted).toBe(false);
      }
      expect(state.cardReader.mock.calls.length - before).toBeGreaterThan(3);
      const final = await accept();
      expect(final).toMatchObject({ choice: 2, key: '201,202,203', accepted: true });
      expect(final.meta?.rerollsRemaining).toBe(1);
    },
  );
  it('waits through gradual fading of the actual R2C3 regions and commits only their settled raw IDs', async () => {
    state.round = 2;
    state.choice = 3;
    state.actualCards = true;
    state.actualNameOcr = true;
    await actualCardPixels('round2-choice3');
    const originals = regions.map((r) => new Uint8Array(r.buffer).slice());
    for (let value = 0; value <= 240; value += 10) {
      regions.forEach((r, slot) => {
        const pixels = new Uint8Array(r.buffer),
          original = originals[slot]!;
        for (let i = 0; i < pixels.length; i++)
          pixels[i] = i % 4 === 3 ? original[i]! : Math.round((original[i]! * value) / 255);
      });
      expect((await frame(100)).accepted).toBe(false);
    }
    regions.forEach((r, slot) => new Uint8Array(r.buffer).set(originals[slot]!));
    const final = await accept();
    expect(final.reads.map((r) => r.itemId)).toEqual(
      ['Superior Duration', 'Tankbuster', 'Spiritual Overflow'].map((n) => itemByName(n).id),
    );
    expect(final.meta?.rerollsRemaining).toBe(1);
  });
  it('corrects the actual weak enhanced R2C3 triple through independent exact names and keeps its count and modifiers', async () => {
    state.round = 2;
    state.choice = 3;
    state.cards = ['Titanic Magazine', 'Cloak of Opportunity', 'Titanic Magazine'].map((n) => itemByName(n).id);
    await actualCardPixels('choice2');
    await accept();
    vi.advanceTimersByTime(5000);
    state.actualCards = true;
    state.actualNameOcr = true;
    await actualCardPixels('round2-choice3');
    const first = await frame();
    expect(first).toMatchObject({ pendingTransition: true, reads: [], accepted: false });
    const final = await accept();
    expect(final.reads.map((r) => r.itemId)).toEqual(
      ['Superior Duration', 'Tankbuster', 'Spiritual Overflow'].map((n) => itemByName(n).id),
    );
    expect(final.reads.map((r) => [r.rare, r.enhanced])).toEqual([
      [false, false],
      [false, true],
      [true, true],
    ]);
    expect(final).toMatchObject({ round: 2, choice: 3, transition: 'reacquire' });
    expect(final.meta?.rerollsRemaining).toBe(1);
    expect(state.nameReads).toHaveBeenCalledTimes(2);
  }, 20_000);
  it('corrects actual R4C3 with exact weak-slot text while strong neighbors do not require OCR', async () => {
    state.round = 4;
    state.choice = 3;
    state.cards = ['Titanic Magazine', 'Cloak of Opportunity', 'Titanic Magazine'].map((n) => itemByName(n).id);
    await actualCardPixels('choice2');
    await accept();
    vi.advanceTimersByTime(5000);
    state.actualCards = true;
    state.actualNameOcr = true;
    await actualCardPixels('round4-choice3');
    expect(await frame()).toMatchObject({ pendingTransition: true, accepted: false, reads: [] });
    const final = await accept();
    expect(final.reads.map((r) => r.itemId)).toEqual(
      ['Vampiric Burst', 'Armor Piercer', 'Spellslinger'].map((n) => itemByName(n).id),
    );
    expect(final.reads[0]!.enhanced).toBe(true);
    expect(final).toMatchObject({ transition: 'reacquire', round: 4, choice: 3 });
    expect(final.meta?.rerollsRemaining).toBe(1);
    expect(state.nameReads).toHaveBeenCalledTimes(1);
  }, 20_000);
  it('resolves the actual present but wrong Heroic Aura icon before committing R2C2, including after F8 reset', async () => {
    state.round = 2;
    state.choice = 2;
    state.actualCards = true;
    state.actualLabels = true;
    state.actualNameOcr = true;
    await actualCardPixels('round2-choice2');
    expect(await frame()).toMatchObject({ accepted: false, pending: true, reads: [], key: '' });
    // Force a raw reread while HUD pixels animate: the corrected tuple must keep its own stable anchor.
    const header = regions.find((r) => r.y === 0)!;
    const pixels = new Uint8Array(header.buffer);
    for (let y = 0; y < 64; y++) pixels.fill(255, y * header.width * 4, (y * header.width + 64) * 4);
    const final = await accept();
    const expected = ['Heroic Aura', 'Headhunter', 'Spirit Snatch'].map((name) => itemByName(name).id);
    expect(final.reads.map((r) => r.itemId)).toEqual(expected);
    expect(final.reads[0]).toMatchObject({ enhanced: true, rare: false, present: true });
    expect(final.reads[0]!.match.score).toBeLessThan(0.82);
    expect(final.reads[0]!.match.margin).toBeLessThan(0.08);
    expect(final).toMatchObject({ round: 2, choice: 2, transition: 'initial', accepted: true });
    // F8 recaptures cannot revive the wrong raw ID or get stuck denying the same visible names.
    await handle({ data: { type: 'reset' } } as MessageEvent<WorkerIn>);
    await actualCardPixels('round2-choice2');
    expect((await accept()).reads.map((r) => r.itemId)).toEqual(expected);
  }, 20_000);
  it('recovers the actual R3C2 thin glyphs with one exact grayscale retry, skipping its strong neighbors', async () => {
    state.round = 3;
    state.choice = 2;
    state.actualCards = true;
    state.actualLabels = true;
    state.actualNameOcr = true;
    await actualCardPixels('round3-choice2');
    expect(await frame()).toMatchObject({ accepted: false, pending: true, reads: [], key: '' });
    const final = await accept();
    expect(final.reads.map((r) => r.itemId)).toEqual(
      ['Spellslinger', 'Superior Duration', 'Burst Fire'].map((name) => itemByName(name).id),
    );
    expect(final.reads[0]).toMatchObject({ present: true, rare: true, enhanced: true });
    expect(final.reads[0]!.match.score).toBeLessThan(0.82);
    expect(final).toMatchObject({ round: 3, choice: 2, accepted: true, transition: 'initial' });
    expect(state.nameReads).toHaveBeenCalledTimes(2);
  }, 20_000);
  it('confirms the actual R3C3 long tilted name above the strict confidence floor before offering advice', async () => {
    state.round = 3;
    state.choice = 3;
    state.actualCards = true;
    state.actualLabels = true;
    state.actualNameOcr = true;
    await actualCardPixels('round3-choice3');
    expect(await frame()).toMatchObject({ accepted: false, pending: true, reads: [], key: '' });
    const final = await accept();
    expect(final.reads.map((r) => r.itemId)).toEqual(
      ['Spiritual Overflow', 'Transcendent Cooldown', 'Echo Shard'].map((name) => itemByName(name).id),
    );
    expect(final.reads[1]).toMatchObject({ present: true, enhanced: true, rare: false });
    expect(final.reads[1]!.match.score).toBeLessThan(0.82);
    expect(final).toMatchObject({ round: 3, choice: 3, accepted: true, transition: 'initial' });
    expect(state.nameReads).toHaveBeenCalledTimes(1);
  }, 20_000);
  it('keeps the full tilted Escalating Resilience label and confirms the actual R1C3 rare offer', async () => {
    state.round = 1;
    state.choice = 3;
    state.actualCards = true;
    state.actualLabels = true;
    state.actualNameOcr = true;
    await actualCardPixels('round1-choice3');
    expect(await frame()).toMatchObject({ accepted: false, pending: true, reads: [], key: '' });
    const final = await accept();
    expect(final.reads.map((r) => r.itemId)).toEqual(
      ['Metal Skin', 'Escalating Resilience', 'Cheat Death'].map((name) => itemByName(name).id),
    );
    expect(final.reads[1]!.match.score).toBeLessThan(0.82);
    expect(final.reads[2]!.rare).toBe(true);
    expect(final).toMatchObject({ round: 1, choice: 3, accepted: true, transition: 'initial' });
    expect(state.nameReads).toHaveBeenCalledTimes(1);
  }, 20_000);
  it('publishes no initial recommendation while any card is incomplete, then waits for the complete fresh tuple', async () => {
    state.visible = 2;
    for (let i = 0; i < 4; i++)
      expect(await frame()).toMatchObject({ pending: true, reads: [], key: '', accepted: false });
    state.visible = 3;
    expect(await frame()).toMatchObject({ pending: true, reads: [], key: '', accepted: false });
    expect(await frame()).toMatchObject({ pending: true, reads: [], key: '', accepted: false });
    expect(await frame()).toMatchObject({ accepted: true, key: '101,102,103' });
  });
  it('leaves weak new candidates pending unless exact text independently validates them', async () => {
    state.cardScores = [0.643, 0.522, 0.818];
    for (let i = 0; i < 5; i++) expect(await frame()).toMatchObject({ accepted: false, reads: [], key: '' });
    expect(state.nameReads).toHaveBeenCalledTimes(12); // Two bounded preprocessing attempts per weak slot.
    state.cardScores = [];
    rosterPixels(255);
    expect(await accept()).toMatchObject({ accepted: true, key: '101,102,103' });
    state.choice = 2;
    state.cards = [201, 202, 203];
    cardPixels(255);
    state.cardScores = [0.643, 0.522, 0.818];
    for (let i = 0; i < 5; i++) expect((await frame()).accepted).toBe(false);
    state.cardScores = [];
    rosterPixels(0);
    expect(await accept()).toMatchObject({ accepted: true, transition: 'choice', key: '201,202,203' });
  });
  it('reports the unread slot without repeating completed OCR over forty unchanged frames, and F8 permits a fresh attempt', async () => {
    state.cardScores = [0.99, 0.6, 0.99];
    for (let i = 0; i < 40; i++) {
      const result = await frame(1100);
      expect(result).toMatchObject({
        accepted: false,
        reads: [],
        key: '',
        itemReadStatus: { confirmed: 2, phase: 'unknown', unresolved: [1] },
      });
    }
    // The first observation establishes a visual epoch; each epoch gets one two-pass ladder.
    expect(state.nameReads).toHaveBeenCalledTimes(4);
    const before = state.nameReads.mock.calls.length;
    await handle({ data: { type: 'reset' } } as MessageEvent<WorkerIn>);
    await frame();
    expect(state.nameReads.mock.calls.length).toBeGreaterThan(before);
    state.cardScores = [];
    cardPixels(80); // A newly clear icon is a changed picture, not a different score on identical pixels.
    expect(await accept()).toMatchObject({ accepted: true, key: '101,102,103' });
  });
  it('waits for complete stable pixels, then corrects real C2/C3 screen cards after old same-ID label animation beyond the correction window', async () => {
    state.actualCards = true;
    state.round = 1;
    state.choice = 1;
    await actualCardPixels('choice3');
    expect(await frame()).toMatchObject({ pending: true, accepted: false, reads: [], key: '' });
    expect(await frame()).toMatchObject({ pending: true, accepted: false, reads: [], key: '' });
    const first = await accept();
    expect(first.reads.map((r) => r.itemId)).toEqual(
      ['Fortitude', 'Lifestrike', 'Veil Walker'].map((n) => itemByName(n).id),
    );
    state.choice = 2;
    await frame();
    const settling = await frame();
    expect(settling).toMatchObject({ pendingTransition: true, accepted: false, reads: [], key: '' });
    for (let i = 0; i < 3; i++) expect((await frame()).accepted).toBe(false);
    // A genuine identical-ID next offer can eventually settle, but this never makes later clear pixels immutable.
    await accept();
    vi.advanceTimersByTime(5000);
    await actualCardPixels('choice2');
    const start = await frame();
    expect(start).toMatchObject({ pendingTransition: true, reads: [], accepted: false });
    const corrected = await accept();
    expect(corrected.transition).toBe('reacquire');
    expect(corrected.reads.map((r) => r.itemId)).toEqual(
      ['Mystic Shot', 'Long Range', 'Fortitude'].map((n) => itemByName(n).id),
    );
    expect(corrected.reads[2]!.rare).toBe(true);
    expect(corrected.meta?.rerollsRemaining).toBe(1);
    state.choice = 3;
    await actualCardPixels('choice3');
    expect((await frame()).accepted).toBe(false);
    expect((await frame()).pendingTransition).toBe(true);
    const last = await accept();
    expect(last.reads.map((r) => r.itemId)).toEqual(first.reads.map((r) => r.itemId));
    expect(last).toMatchObject({ round: 1, choice: 3, transition: 'choice' });
    expect(last.meta?.rerollsRemaining).toBe(1);
  });
  it('retains full capture and the committed offer when a tooltip hides the choice label but an unchanged known card remains', async () => {
    for (const region of regions.slice(0, 3)) {
      const pixels = new Uint8Array(region.buffer);
      for (let y = 0; y < region.height; y++)
        for (let x = 0; x < region.width; x++) {
          const n = (y * region.width + x) * 4;
          const value = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 230 : 20;
          pixels[n] = pixels[n + 1] = pixels[n + 2] = value;
          pixels[n + 3] = 255;
        }
    }
    const committed = await accept();
    state.choice = 0;
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5000);
      expect(await frame()).toMatchObject({ shop: true, accepted: false, key: committed.key, choice: 1 });
      expect(outputs.at(-1)?.type).toBe('result');
    }
    expect(state.cardReader).toHaveBeenCalledTimes(1);
  });
  it('publishes a partial actual first-round roster while items remain blocked and keeps retrying a blanked portrait', async () => {
    state.actualSelf = true;
    state.actualLabels = true;
    state.round = 1;
    state.choice = 3;
    state.cardScore = 0.5;
    await actualCardPixels('round1-choice3');
    // The real fourth teammate is Abrams, now recovered by the foreground fallback.
    // Explicitly remove his portrait to keep this an independent unknown-slot retry regression.
    const { sx, sy, offsetX } = hudLayout(frameWidth, frameHeight);
    const cx = offsetX + HERO_BAR.left[3] * sx,
      cy = HERO_BAR.cy * sy;
    const bar = regions.find((region) => region.y === 0)!;
    const pixels = new Uint8Array(bar.buffer);
    for (let y = Math.max(0, Math.floor(cy - 54 * sx)); y < cy + 54 * sx; y++)
      for (let x = Math.floor(cx - 54 * sx); x < cx + 54 * sx; x++)
        pixels.set([58, 74, 88, 255], ((y - bar.y) * bar.width + x - bar.x) * 4);
    for (let i = 0; i < 4; i++)
      expect(await frame(500)).toMatchObject({ accepted: false, pending: true, reads: [], key: '' });
    const identities = outputs.filter((m): m is FrameResult => m.type === 'result' && !!m.identityOnly);
    expect(identities.at(-1)?.teamRoster).toEqual({ self: 76, left: [76, 65, 67, 0], right: [79, 27, 84, 1] });
    const readsBefore = state.metadataReader.mock.calls.length;
    await frame(2000);
    expect(state.metadataReader.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(
      outputs.filter((m): m is FrameResult => m.type === 'result').every((r) => !r.accepted && !r.reads.length),
    ).toBe(true);
  });
  it('publishes the full team only after two independent portrait reads and caches it through tooltip corruption', async () => {
    state.round = 1;
    state.team = [1, 10, 11, 12];
    expect((await accept()).teamRoster).toBeNull();
    const confirmed = await frame();
    expect(confirmed.teamRoster).toEqual({ self: 1, left: state.team, right: state.foes });
    expect(state.metadataReader).toHaveBeenCalledTimes(2);
    state.team = [1, 0, 0, 0];
    state.cards = [201, 202, 203];
    state.cardScore = 0.6;
    cardPixels(255);
    for (let i = 0; i < 3; i++) expect((await frame()).teamRoster).toEqual(confirmed.teamRoster);
    expect(state.metadataReader).toHaveBeenCalledTimes(2);
    await closeDraft();
    await frame();
    expect((await frame()).teamRoster).toBeNull();
  });
  it('holds the committed offer and known count through repeated foreign cards and false labels, then commits real advances', async () => {
    const initial = await accept();
    expect(initial.meta?.rerollsRemaining).toBe(1);
    state.cards = [201, 202, 203];
    state.cardScore = 0.6;
    new Uint8Array(regions[0]!.buffer).fill(255);
    for (let i = 0; i < 3; i++) {
      const tooltip = await frame();
      expect(tooltip.key).toBe(initial.key);
      expect(tooltip.reads.map((r) => r.itemId)).toEqual([101, 102, 103]);
      expect(tooltip.accepted).toBe(false);
      expect(tooltip.meta?.rerollsRemaining).toBe(1);
    }
    state.choice = 2;
    expect((await frame()).choice).toBe(1); // One false legal label cannot commit.
    state.choice = 1;
    await frame();
    state.round = 1;
    for (let i = 0; i < 3; i++) expect((await frame()).round).toBe(3);
    state.round = 3;
    state.choice = 2;
    state.cardScore = 0.99;
    expect((await frame()).accepted).toBe(false);
    const picked = await accept();
    expect(picked).toMatchObject({ accepted: true, transition: 'choice', round: 3, choice: 2, key: '201,202,203' });
    state.round = 4;
    state.choice = 1;
    state.cards = [301, 302, 303];
    cardPixels(80);
    await frame();
    expect(await accept()).toMatchObject({
      accepted: true,
      transition: 'round',
      round: 4,
      choice: 1,
      key: '301,302,303',
    });
  });
  it('requires two fresh frames after a confirmed reroll even when all three item IDs repeat', async () => {
    const initial = await accept();
    state.rerolls = 0;
    state.spent = true;
    expect(await frame()).toMatchObject({ pending: true, accepted: false, key: '', reads: [] });
    expect(await frame()).toMatchObject({ pending: true, accepted: false, key: '', reads: [] });
    const rerolled = await accept();
    expect(rerolled).toMatchObject({ accepted: true, transition: 'reroll', key: initial.key });
    expect(rerolled.meta?.rerollsRemaining).toBe(0);
  });
  it('keeps a new choice and its actual spent count when reroll arrives during card settling', async () => {
    await accept();
    state.choice = 2;
    state.cards = [201, 202, 203];
    cardPixels(255);
    await frame();
    expect((await frame()).pendingTransition).toBe(true);
    state.rerolls = 0;
    state.spent = true;
    expect((await frame()).pendingTransition).toBe(true);
    const final = await accept();
    expect(final).toMatchObject({ choice: 2, transition: 'reroll', key: '201,202,203' });
    expect(final.meta?.rerollsRemaining).toBe(0);
  });
  it('ends the draft on the real SELECTS COMPLETE screenshot probe without matching its empty card circles', async () => {
    expect((await accept()).accepted).toBe(true);
    const before = state.cardReader.mock.calls.length;
    // Exact CHOICE probe from the supplied 3439x1439 ultrawide screenshot; full screenshot stays outside the repo.
    const { data } = await sharp('src/brawl/__tests__/assets/selects-complete-probe.png')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    state.actualLabels = true;
    const region = { x: 674, y: 375, width: 39, height: 57, buffer: new Uint8Array(data).buffer };
    const start = outputs.length;
    await handle({
      data: { type: 'frame', width: 3439, height: 1439, regions: [region], prefer: [] },
    } as unknown as MessageEvent<WorkerIn>);
    const ended = outputs.slice(start).find((result): result is FrameResult => result.type === 'result')!;
    expect(ended.shop).toBe(false);
    expect(ended.key).toBe('');
    expect(ended.reads).toEqual([]);
    expect(ended.meta).toBeNull();
    expect(state.cardReader).toHaveBeenCalledTimes(before);
  });
  it('preserves nonshop side-correction provenance through unread opponents and updates retained metadata', async () => {
    state.round = 1;
    state.self = 67;
    state.team = [67, 10, 11, 12];
    await accept();
    await frame(500);
    const memory = new MatchMemory();
    memory.observeRoster(67, state.foes, 1);
    memory.observeRoster(67, state.foes, 1);
    memory.observeInventory(state.inventory, items, 10);
    const acquired = [...memory.acquisitions];
    const caption = await sharp('src/local/__tests__/assets/round-countdown.png').ensureAlpha().raw().toBuffer();
    regions.push({ x: frameWidth - 439, y: 365, width: 420, height: 70, buffer: Uint8Array.from(caption).buffer });
    state.choice = 0;
    state.self = 76;
    state.selfSide = 'right';
    state.selfSlot = 2;
    state.foes = [2, 3, 76, 5];
    state.team = [67, 10, 11, 0];
    await frame(5000);
    await frame(500);
    let correction = outputs.filter((m): m is FrameResult => m.type === 'result' && !!m.identityOnly).at(-1)!;
    expect(correction).toMatchObject({ shop: false, transition: 'hero', meta: { self: 76 } });
    expect(memory.observeRoster(76, state.team, 1, correction.transition === 'hero').newMatch).toBe(false);
    state.team = [67, 10, 11, 12];
    await frame(500);
    correction = outputs.filter((m): m is FrameResult => m.type === 'result' && !!m.identityOnly).at(-1)!;
    expect(correction).toMatchObject({ transition: 'hero', meta: { self: 76 } });
    expect(memory.observeRoster(76, state.team, 1, correction.transition === 'hero').newMatch).toBe(false);
    expect(memory.owned).toEqual(state.inventory);
    expect(memory.acquisitions).toEqual(acquired);
    // Any retained metadata must carry the corrected self, never the previous interpretation.
    const next = await frame(500);
    if (next.meta) expect(next.meta.self).toBe(76);
    state.choice = 2;
    expect((await accept()).meta?.self).toBe(76);
  });
  it('reacquires player and full team after F8 on actual first preparation without reading any item cards', async () => {
    await actualCardPixels('round1-choice3');
    regions = regions.filter((r) => r.y === 0);
    const file = 'src/local/__tests__/assets/round-countdown-draft-choice3';
    const origin = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
    const { data, info } = await sharp(`${file}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    regions.push({
      x: origin.x,
      y: origin.y,
      width: info.width,
      height: info.height,
      buffer: Uint8Array.from(data).buffer,
    });
    state.actualSelf = true;
    state.actualLabels = true;
    await handle({ data: { type: 'reset' } } as MessageEvent<WorkerIn>);
    for (let i = 0; i < 4; i++)
      expect(await frame(500)).toMatchObject({
        shop: false,
        preparationRound: 1,
        roundCountdown: true,
        reads: [],
        key: '',
      });
    const identity = outputs.filter((m): m is FrameResult => m.type === 'result' && !!m.identityOnly).at(-1)!;
    expect(identity).toMatchObject({
      shop: false,
      accepted: false,
      meta: { self: 76 },
      teamRoster: { self: 76, left: [76, 65, 67, 6], right: [79, 27, 84, 1] },
    });
    expect(state.cardReader).not.toHaveBeenCalled();
    expect(state.nameReads).not.toHaveBeenCalled();
    // A later-round caption cannot acquire a first-preparation roster, even after a raw ROUND1 glitch.
    await handle({ data: { type: 'reset' } } as MessageEvent<WorkerIn>);
    state.actualLabels = false;
    state.round = 2;
    state.choice = 0;
    state.selfReader.mockClear();
    await frame(500);
    await frame(500);
    state.round = 1;
    await frame(500);
    expect(state.selfReader).not.toHaveBeenCalled();
  });
  it('reads real first-round preparation regions after picks, keeps full cheap cue polling, and returns to probes on gameplay', async () => {
    state.round = 1;
    state.team = [1, 6, 7, 8];
    await accept();
    const calls = state.cardReader.mock.calls.length;
    frameWidth = 3439;
    frameHeight = 1439;
    const caption = await sharp('src/local/__tests__/assets/round-countdown.png').ensureAlpha().raw().toBuffer();
    const round = await sharp('src/local/__tests__/assets/preparation-round1.png').ensureAlpha().raw().toBuffer();
    regions = [
      { x: 3000, y: 365, width: 420, height: 70, buffer: Uint8Array.from(caption).buffer },
      { x: 1745, y: 40, width: 65, height: 55, buffer: Uint8Array.from(round).buffer },
    ];
    state.actualLabels = true;
    const preparation = await frame();
    expect(preparation).toMatchObject({
      shop: false,
      preparationRound: 1,
      roundCountdown: true,
      reads: [],
      key: '',
      meta: null,
    });
    expect(state.cardReader).toHaveBeenCalledTimes(calls);
    vi.advanceTimersByTime(300);
    expect(outputs.filter((m) => m.type === 'tick').at(-1)).toMatchObject({ full: true });
    expect(await frame(11_000)).toMatchObject({ shop: false, roundCountdown: true });
    // Same real ROUND 1, but no fixed caption: the first-round preparation has ended.
    new Uint8Array(regions[0]!.buffer).fill(0);
    expect(await frame(600)).toMatchObject({ shop: false, preparationRound: 1, roundCountdown: false });
    vi.advanceTimersByTime(300);
    expect(outputs.filter((m) => m.type === 'tick').at(-1)).toMatchObject({ full: false });
    // A capture restart/F8 reads one full frame and can enter the still-visible first preparation.
    regions[0]!.buffer = Uint8Array.from(caption).buffer;
    await handle({ data: { type: 'reset' } } as MessageEvent<WorkerIn>);
    vi.advanceTimersByTime(0);
    expect(outputs.filter((m) => m.type === 'tick').at(-1)).toMatchObject({ full: true });
    expect(await frame()).toMatchObject({ shop: false, preparationRound: 1, roundCountdown: true });
    state.actualLabels = false;
    state.round = 2;
    state.choice = 0;
    expect(await frame()).toMatchObject({ shop: false, preparationRound: 2, roundCountdown: true });
    vi.advanceTimersByTime(300);
    expect(outputs.filter((m) => m.type === 'tick').at(-1)).toMatchObject({ full: true });
    expect(await frame()).toMatchObject({ shop: false, preparationRound: 2, roundCountdown: true });
    vi.advanceTimersByTime(300);
    expect(outputs.filter((m) => m.type === 'tick').at(-1)).toMatchObject({ full: false });
  });
  it('publishes inventory on identical frames and preserves it through initial roster confirmation', async () => {
    const memory = new MatchMemory();
    const results: FrameResult[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await frame();
      results.push(result);
      if (result.meta) memory.observeRoster(result.meta.self, state.foes, result.round);
      if (result.inventory) memory.observeInventory(result.inventory, items, i);
    }
    expect(results.map((r) => r.inventory)).toEqual([null, state.inventory, null, null, null]);
    expect(memory.enemies).toEqual(state.foes);
    expect(memory.owned).toEqual(state.inventory);
    expect(memory.acquisitions).toHaveLength(1);
    expect(state.inventoryReader).toHaveBeenCalledTimes(2);
    expect(state.cardReader).toHaveBeenCalledTimes(1);
    const bought = items.find((i) => i.item_tier > 0 && i.id !== state.inventory[0])!.id;
    state.inventory.push(bought);
    inventoryPixels(255);
    expect((await frame()).inventory).toBeNull();
    const updated = await frame();
    expect(updated.inventory).toEqual([...state.inventory].sort((a, b) => a - b));
    memory.observeInventory(updated.inventory!, items, 10);
    expect(memory.owned).toHaveLength(2);
    expect(state.cardReader).toHaveBeenCalledTimes(1);
    expect(state.inventoryReader).toHaveBeenCalledTimes(4);
  });
  it.each(['new roster', 'same roster restart'])('republishes unchanged inventory after %s', async (kind) => {
    const memory = new MatchMemory();
    const consume = (result: FrameResult, now: number) => {
      if (result.meta) memory.observeRoster(result.meta.self, state.foes, result.round);
      if (result.inventory) memory.observeInventory(result.inventory, items, now);
    };
    for (let i = 0; i < 5; i++) consume(await frame(), i);
    await closeDraft();
    if (kind === 'new roster') {
      state.foes = [6, 7, 8, 9];
      state.cards = [201, 202, 203];
      rosterPixels(255);
    }
    state.round = 1;
    for (let i = 5; i < 12; i++) consume(await frame(), i);
    expect(memory.enemies).toEqual(state.foes);
    expect(memory.owned).toEqual(state.inventory);
    expect(memory.acquisitions).toHaveLength(1);
    expect(memory.acquisitions[0]!.observedAt).toBeGreaterThanOrEqual(5);
  });
  it('retries an incomplete roster while cards stay settled and republishes its inventory', async () => {
    const memory = new MatchMemory();
    const consume = (result: FrameResult, now: number) => {
      if (result.meta) memory.observeRoster(result.meta.self, state.foes, result.round);
      if (result.inventory) memory.observeInventory(result.inventory, items, now);
    };
    for (let i = 0; i < 5; i++) consume(await frame(), i);
    await closeDraft();
    state.foes = [6, 7, 8];
    state.round = 1;
    state.cards = [201, 202, 203];
    rosterPixels(255);
    consume(await frame(), 5);
    consume(await frame(), 6);
    expect(memory.enemies).toEqual([2, 3, 4, 5]);
    state.foes = [6, 7, 8, 9];
    vi.advanceTimersByTime(500);
    const recovered = await frame();
    expect(recovered.accepted).toBe(true);
    expect(recovered.meta?.bar.right).toHaveLength(4);
    consume(recovered, 7);
    for (let i = 8; i < 12; i++) consume(await frame(), i);
    expect(memory.enemies).toEqual(state.foes);
    expect(memory.owned).toEqual(state.inventory);
    expect(memory.acquisitions).toHaveLength(1);
    expect(state.cardReader).toHaveBeenCalledTimes(2);
  });
});
