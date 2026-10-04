import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftRegions, inventoryRegions, type CardRead } from '../recognise';
import type { FrameRegion, FrameResult, WorkerIn, WorkerOut } from '../worker';
import type { IconIndex } from '../types';
import { MatchMemory } from '../../local/matchMemory';
import { items, itemByName } from './testData';

const state = vi.hoisted(() => ({
  round: 3,
  inventory: [] as number[],
  foes: [2, 3, 4, 5],
  cards: [101, 102, 103],
  inventoryReader: vi.fn(),
  cardReader: vi.fn(),
}));
vi.mock('../recognise', async (original) => ({
  ...(await original<typeof import('../recognise')>()),
  decodeIconIndex: () => ({}),
  readRoundChoice: () => ({ round: state.round, choice: 1 }),
  readInventory: () => {
    state.inventoryReader();
    return state.inventory.map((itemId, slot) => ({ itemId, slot }));
  },
  readDraftScreen: () => {
    state.cardReader();
    return state.cards.map((itemId) => ({ itemId, present: true, enhanced: false })) as CardRead[];
  },
  readDraftMeta: () => ({
    round: state.round,
    choice: 1,
    self: 1,
    bar: { left: [{ heroId: 1 }], right: state.foes.map((heroId) => ({ heroId })) },
    rerollsRemaining: -1,
  }),
}));
vi.mock('../ocr', () => ({ warmOCR: vi.fn(), terminateOCR: vi.fn() }));
vi.mock('../../local/cardNameOcr', () => ({ readItemName: vi.fn(), stopItemNameOCR: vi.fn() }));
vi.mock('../../local/rerollCounter', () => ({
  RerollCounterReader: class {
    value = null;
    reset() {}
    poll() {}
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
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  state.round = 3;
  state.inventory = [itemByName('Extra Stamina').id];
  state.foes = [2, 3, 4, 5];
  state.cards = [101, 102, 103];
  state.inventoryReader.mockClear();
  state.cardReader.mockClear();
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
    if (kind === 'new roster') {
      state.foes = [6, 7, 8, 9];
      state.cards = [201, 202, 203];
      rosterPixels(255);
    }
    state.round = 1;
    for (let i = 5; i < 10; i++) consume(await frame(), i);
    expect(memory.enemies).toEqual(state.foes);
    expect(memory.owned).toEqual(state.inventory);
    expect(memory.acquisitions).toEqual([{ itemId: state.inventory[0], observedAt: 7 }]);
  });
  it('retries an incomplete roster while cards stay settled and republishes its inventory', async () => {
    const memory = new MatchMemory();
    const consume = (result: FrameResult, now: number) => {
      if (result.meta) memory.observeRoster(result.meta.self, state.foes, result.round);
      if (result.inventory) memory.observeInventory(result.inventory, items, now);
    };
    for (let i = 0; i < 5; i++) consume(await frame(), i);
    state.foes = [6, 7, 8];
    state.round = 1;
    state.cards = [201, 202, 203];
    rosterPixels(255);
    consume(await frame(), 5);
    consume(await frame(), 6);
    expect(memory.enemies).toEqual([2, 3, 4, 5]);
    state.foes = [6, 7, 8, 9];
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
