import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { draftRegions, inventoryRegions, type CardRead } from '../recognise';
import type { FrameRegion, FrameResult, WorkerIn, WorkerOut } from '../worker';
import type { IconIndex } from '../types';
import { MatchMemory } from '../../local/matchMemory';
import { items, itemByName } from './testData';

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
  inventoryReader: vi.fn(),
  cardReader: vi.fn(),
  metadataReader: vi.fn(),
}));
vi.mock('../recognise', async (original) => {
  const actual = await original<typeof import('../recognise')>();
  return {
    ...actual,
    decodeIconIndex: () => ({}),
    readRoundChoice: (img: import('../recognise').RGBImage) =>
      state.actualLabels ? actual.readRoundChoice(img) : { round: state.round, choice: state.choice },
    readInventory: () => {
      state.inventoryReader();
      return state.inventory.map((itemId, slot) => ({ itemId, slot }));
    },
    readDraftScreen: () => {
      state.cardReader();
      return state.cards.map((itemId) => ({ itemId, present: true, enhanced: false })) as CardRead[];
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
vi.mock('../../local/cardNameOcr', () => ({ readItemName: vi.fn(), stopItemNameOCR: vi.fn() }));
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
const frame = async () => {
  const before = outputs.length;
  await handle({
    data: { type: 'frame', width: 2560, height: 1440, regions, prefer: [] },
  } as unknown as MessageEvent<WorkerIn>);
  return outputs.slice(before).find((m): m is FrameResult => m.type === 'result')!;
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
  state.inventoryReader.mockClear();
  state.cardReader.mockClear();
  state.metadataReader.mockClear();
  outputs = [];
  regions = draftRegions(2560, 1440).map((r) => ({ ...r, buffer: new ArrayBuffer(r.width * r.height * 4) }));
  vi.stubGlobal('self', {
    addEventListener: (_: string, listener: typeof handle) => {
      handle = listener;
    },
    postMessage: (message: WorkerOut) => outputs.push(message),
  });
  await import('../worker');
  await handle({
    data: { type: 'init', index: {} as IconIndex, tiers: {}, intervalMs: 100 },
  } as MessageEvent<WorkerIn>);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worker confirmed state', () => {
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
    await frame();
    const committed = await frame();
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
    await frame();
    expect((await frame()).teamRoster).toBeNull();
    const confirmed = await frame();
    expect(confirmed.teamRoster).toEqual({ self: 1, left: state.team, right: state.foes });
    expect(state.metadataReader).toHaveBeenCalledTimes(2);
    state.team = [1, 0, 0, 0];
    state.cards = [201, 202, 203];
    cardPixels(255);
    for (let i = 0; i < 3; i++) expect((await frame()).teamRoster).toEqual(confirmed.teamRoster);
    expect(state.metadataReader).toHaveBeenCalledTimes(2);
    await closeDraft();
    await frame();
    expect((await frame()).teamRoster).toBeNull();
  });
  it('holds the committed offer and known count through repeated foreign cards and false labels, then commits real advances', async () => {
    await frame();
    const initial = await frame();
    expect(initial.meta?.rerollsRemaining).toBe(1);
    state.cards = [201, 202, 203];
    cardPixels(255);
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
    expect((await frame()).accepted).toBe(false);
    const picked = await frame();
    expect(picked).toMatchObject({ accepted: true, transition: 'choice', round: 3, choice: 2, key: '201,202,203' });
    state.round = 4;
    state.choice = 1;
    state.cards = [301, 302, 303];
    cardPixels(80);
    await frame();
    expect(await frame()).toMatchObject({
      accepted: true,
      transition: 'round',
      round: 4,
      choice: 1,
      key: '301,302,303',
    });
  });
  it('requires two fresh frames after a confirmed reroll even when all three item IDs repeat', async () => {
    await frame();
    const initial = await frame();
    state.rerolls = 0;
    state.spent = true;
    expect(await frame()).toMatchObject({ pending: true, accepted: false, key: '', reads: [] });
    expect(await frame()).toMatchObject({ pending: true, accepted: false, key: '', reads: [] });
    const rerolled = await frame();
    expect(rerolled).toMatchObject({ accepted: true, transition: 'reroll', key: initial.key });
    expect(rerolled.meta?.rerollsRemaining).toBe(0);
  });
  it('ends the draft on the real SELECTS COMPLETE screenshot probe without matching its empty card circles', async () => {
    await frame();
    expect((await frame()).accepted).toBe(true);
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
    for (let i = 5; i < 10; i++) consume(await frame(), i);
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
