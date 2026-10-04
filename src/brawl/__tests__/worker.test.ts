import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { draftRegions, inventoryRegions, type CardRead } from '../recognise';
import type { FrameRegion, FrameResult, WorkerIn, WorkerOut } from '../worker';
import type { IconIndex } from '../types';
import { MatchMemory } from '../../local/matchMemory';
import { items, itemByName } from './testData';
import { cardNameRegions } from '../../local/cardNames';
import { cardAnchors } from '../recognise';
import { stopItemNameOCR } from '../../local/cardNameOcr';

const state = vi.hoisted(() => ({
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
    readDraftMeta: () => {
      state.metadataReader();
      return {
        round: state.round,
        choice: state.choice,
        self: 1,
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
      state.nameReads();
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
const actualCardPixels = async (name: 'choice2' | 'choice3' | 'round2-choice3') => {
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
  if (name !== 'round2-choice3') namePixels(true);
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
  state.cardScore = 0.99;
  state.cardScores = [];
  state.visible = 3;
  state.actualNameOcr = false;
  state.nameReads.mockClear();
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
    expect(state.nameReads).toHaveBeenCalledTimes(3);
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
  it('preserves legitimate low-score present matches on initial and authorised choice reads while rejecting late weak correction', async () => {
    state.cardScores = [0.643, 0.522, 0.818];
    expect(await accept()).toMatchObject({ accepted: true, key: '101,102,103' });
    state.choice = 2;
    state.cards = [201, 202, 203];
    cardPixels(255);
    expect(await accept()).toMatchObject({ accepted: true, transition: 'choice', key: '201,202,203' });
    vi.advanceTimersByTime(5000);
    state.cards = [301, 302, 303];
    cardPixels(80);
    for (let i = 0; i < 5; i++)
      expect(await frame()).toMatchObject({ accepted: false, key: '', pendingTransition: true });
    expect(state.nameReads).toHaveBeenCalledTimes(3);
    state.cards = [201, 202, 203];
    cardPixels(255);
    const restored = await frame();
    expect(restored).toMatchObject({ accepted: true, transition: 'metadata', key: '201,202,203' });
    expect(restored.meta?.rerollsRemaining).toBe(1);
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
