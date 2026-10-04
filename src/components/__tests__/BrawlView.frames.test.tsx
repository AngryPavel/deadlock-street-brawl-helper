// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FrameResult, WorkerOut, WorkerIn } from '../../brawl/worker';
import type { OverlayState } from '../../brawl/draw';
import type { Ability, Hero, Item } from '../../types';
import { DEFAULT_OVERLAY_SETTINGS } from '../../local/overlaySettings';

const readJson = (rel: string) =>
  JSON.parse(readFileSync(path.resolve(__dirname, '../../../public/data', rel), 'utf8'));
vi.mock('../../data/load', () => ({ j: (rel: string) => Promise.resolve(readJson(rel)), img: (p?: string) => p }));
let listener: ((event: MessageEvent<WorkerOut>) => void) | undefined;
const sent: OverlayState[] = [];
const workerMessages: WorkerIn[] = [];
let detectRun: (() => void) | undefined;
(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  getGameRect: () => Promise.resolve(null),
  onGameRect: () => () => {},
  onDetectRun: (cb: () => void) => {
    detectRun = cb;
    return () => {
      detectRun = undefined;
    };
  },
  getCaptureState: () => Promise.resolve({ wanted: false, probe: false }),
  onCaptureState: () => () => {},
  onCaptureDenied: () => () => {},
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
  sendOverlayState: (state: OverlayState) => sent.push(structuredClone(state)),
};
(globalThis as unknown as { Worker: unknown }).Worker = class {
  postMessage(message: WorkerIn) {
    workerMessages.push(message);
  }
  terminate() {}
  addEventListener(_: string, callback: typeof listener) {
    listener = callback;
  }
  removeEventListener() {
    listener = undefined;
  }
};
const { BrawlView } = await import('../BrawlView');
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sent.length = 0;
  workerMessages.length = 0;
  detectRun = undefined;
  listener = undefined;
});

it('clears old item advice after a debounced closed screen and before the ability-tip debounce, while retaining long tooltips', async () => {
  const heroes = readJson('heroes.json') as Hero[];
  const items = readJson('items.json') as Item[];
  const abilities = readJson('abilities.json') as Ability[];
  const hero = heroes.find((h) => h.id === 1)!;
  const ids = ['Swift Striker', 'Quicksilver Reload', 'Spirit Shielding'].map(
    (name) => items.find((i) => i.name === name)!.id,
  );
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: () => Promise.resolve() };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getDisplayMedia: () => Promise.resolve({ getTracks: () => [track], getVideoTracks: () => [track] }),
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const view = render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listener).toBeTypeOf('function'));
  const complete: FrameResult = {
    type: 'result',
    shop: true,
    round: 3,
    choice: 2,
    key: ids.join(','),
    accepted: true,
    inventory: null,
    ms: 0,
    reads: ids.map((itemId, slot) => ({
      card: String(slot),
      itemId,
      present: true,
      tier: 1,
      rare: false,
      enhanced: false,
      match: { itemId, x: slot * 200, y: 200, edge: 185, score: 1, margin: 1 },
    })),
    meta: {
      self: hero.id,
      round: 3,
      choice: 2,
      bar: {
        left: [{ heroId: hero.id, score: 1, margin: 1 }],
        right: [2, 3, 4, 5].map((heroId) => ({ heroId, score: 1, margin: 1 })),
      },
      rerollsRemaining: 1,
    },
  };
  const deliver = async (frame: FrameResult) => {
    await act(async () => listener!({ data: frame } as MessageEvent<WorkerOut>));
  };
  await deliver(complete);
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
  const teamFrame = {
    ...complete,
    round: 1,
    choice: 1,
    transition: 'initial' as const,
    teamRoster: { self: hero.id, left: [1, 2, 3, 4], right: [6, 7, 8, 10] },
    meta: { ...complete.meta!, round: 1, choice: 1 },
  };
  await deliver(teamFrame);
  expect(sent.at(-1)?.teamEdge).toMatchObject({ ownWinRate: expect.any(Number), enemyWinRate: expect.any(Number) });
  const beforeTeam = sent.at(-1)!.teamEdge;
  await deliver({ ...teamFrame, accepted: false, key: '', reads: [], teamRoster: undefined });
  expect(sent.at(-1)?.teamEdge).toEqual(beforeTeam);
  view.rerender(
    <BrawlView
      hero={hero}
      heroes={heroes}
      items={items}
      abilities={abilities}
      onHero={() => {}}
      overlaySettings={{ ...DEFAULT_OVERLAY_SETTINGS, showTeamWinRates: false }}
    />,
  );
  await waitFor(() => expect(sent.at(-1)?.teamEdge).toBeNull());
  view.rerender(
    <BrawlView
      hero={hero}
      heroes={heroes}
      items={items}
      abilities={abilities}
      onHero={() => {}}
      overlaySettings={DEFAULT_OVERLAY_SETTINGS}
    />,
  );
  await waitFor(() => expect(sent.at(-1)?.teamEdge).toEqual(beforeTeam));
  await deliver(complete);
  expect(sent.at(-1)?.teamEdge).toBeNull();
  await deliver({ ...complete, transition: 'metadata', meta: { ...complete.meta!, rerollsRemaining: -1 } });
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
  for (let i = 0; i < 3; i++)
    await deliver({
      ...complete,
      round: 1,
      key: '99,99,99',
      meta: { ...complete.meta!, round: 1, rerollsRemaining: -1 },
    });
  expect(sent.at(-1)?.advice?.round).toBe(3);
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
  const tooltip = {
    ...complete,
    accepted: false,
    key: '',
    reads: complete.reads.map((r, slot) => ({ ...r, present: slot < 2 })),
  };
  now = 15_000;
  await deliver(tooltip);
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  const ended = { ...complete, shop: false, accepted: false, round: 0, choice: 0, key: '', reads: [], meta: null };
  now = 15_100;
  await deliver(ended);
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  now = 15_500;
  await deliver(ended);
  const cleared = sent.at(-1)!;
  expect(cleared.advice).toBeNull();
  expect(cleared.reads).toEqual([]);
  expect(cleared.bestId).toBeNull();
  expect(cleared.panel).toBeNull();
  expect(cleared.draft).toBe(true); // The independently debounced ability tip has not started yet.
  await deliver(complete);
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  await deliver({ ...tooltip, choice: 3 });
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  expect(sent.at(-1)?.advice?.choice).toBe(2);
  await deliver({ ...tooltip, choice: 3, pending: true, pendingTransition: true, reads: [], key: '' });
  expect(sent.at(-1)?.advice).toBeNull();
  expect(sent.at(-1)?.reads).toEqual([]);
  expect(sent.at(-1)?.bestId).toBeNull();
  await deliver({ ...complete, choice: 3, transition: 'choice', meta: { ...complete.meta!, choice: 3 } });
  expect(sent.at(-1)?.advice?.choice).toBe(3);
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
  await deliver({ ...tooltip, choice: 3, pending: true, pendingTransition: true, reads: [], key: '' });
  expect(sent.at(-1)?.advice).toBeNull();
  await deliver({
    ...complete,
    choice: 3,
    transition: 'reacquire',
    meta: { ...complete.meta!, choice: 3, rerollsRemaining: -1 },
  });
  expect(sent.at(-1)?.advice?.choice).toBe(3);
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
  const nextRound = {
    ...complete,
    round: 4,
    choice: 1,
    transition: 'round' as const,
    meta: { ...complete.meta!, round: 4, choice: 1, rerollsRemaining: -1 },
  };
  await deliver(nextRound);
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBeNull();
  await act(async () =>
    listener!({
      data: { type: 'rerolls', forKey: complete.key, forRound: 4, forChoice: 1, rerollsRemaining: 1, spent: false },
    } as MessageEvent<WorkerOut>),
  );
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
});

it('F8 clears current advice immediately, forces independent reset reads, and rejects results from older capture generations', async () => {
  const heroes = readJson('heroes.json') as Hero[],
    items = readJson('items.json') as Item[],
    abilities = readJson('abilities.json') as Ability[];
  const hero = heroes.find((h) => h.id === 1)!,
    onNewMatch = vi.fn();
  const ids = ['Swift Striker', 'Quicksilver Reload', 'Spirit Shielding'].map(
    (name) => items.find((i) => i.name === name)!.id,
  );
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: () => Promise.resolve() };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getDisplayMedia: () => Promise.resolve({ getTracks: () => [track], getVideoTracks: () => [track] }),
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  render(
    <BrawlView
      hero={hero}
      heroes={heroes}
      items={items}
      abilities={abilities}
      onHero={() => {}}
      onNewMatch={onNewMatch}
      debug
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listener).toBeTypeOf('function'));
  const initialEpoch = (workerMessages.find((m) => m.type === 'init') as Extract<WorkerIn, { type: 'init' }>)
    .captureEpoch!;
  const full: FrameResult = {
    type: 'result',
    captureEpoch: initialEpoch,
    shop: true,
    round: 4,
    choice: 1,
    accepted: true,
    transition: 'initial',
    key: ids.join(','),
    reads: ids.map((itemId, slot) => ({
      card: String(slot),
      itemId,
      present: true,
      tier: 1,
      rare: false,
      enhanced: false,
      match: { itemId, x: slot * 200, y: 200, edge: 185, score: 1, margin: 1 },
    })),
    inventory: [items.find((i) => i.name === 'Extra Stamina')!.id],
    ms: 0,
    meta: {
      self: 1,
      round: 4,
      choice: 1,
      bar: {
        left: [{ heroId: 1, score: 1, margin: 1 }],
        right: [2, 3, 4, 5].map((heroId) => ({ heroId, score: 1, margin: 1 })),
      },
      rerollsRemaining: 1,
    },
  };
  const deliver = async (frame: FrameResult) => act(async () => listener!({ data: frame } as MessageEvent<WorkerOut>));
  await deliver(full);
  await deliver({ ...full, accepted: false });
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  expect(onNewMatch).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Owned (1)' })).toBeTruthy();
  await act(async () => detectRun!());
  expect(sent.at(-1)?.advice).toBeNull();
  expect(sent.at(-1)?.reads).toEqual([]);
  let reset = workerMessages.filter((m): m is Extract<WorkerIn, { type: 'reset' }> => m.type === 'reset').at(-1)!;
  expect(reset.captureEpoch).toBeGreaterThan(initialEpoch);
  await deliver(full);
  expect(sent.at(-1)?.advice).toBeNull();
  await act(async () => detectRun!());
  const previousEpoch = reset.captureEpoch;
  reset = workerMessages.filter((m): m is Extract<WorkerIn, { type: 'reset' }> => m.type === 'reset').at(-1)!;
  expect(reset.captureEpoch).toBeGreaterThan(previousEpoch!);
  await deliver({ ...full, captureEpoch: previousEpoch });
  expect(sent.at(-1)?.advice).toBeNull();
  await deliver({
    ...full,
    captureEpoch: reset.captureEpoch,
    accepted: false,
    pending: true,
    key: '',
    reads: [],
    meta: null,
  });
  expect(sent.at(-1)?.advice).toBeNull();
  await deliver({
    ...full,
    captureEpoch: reset.captureEpoch,
    inventory: null,
    meta: {
      ...full.meta!,
      self: 2,
      bar: {
        left: [6, 12, 13, 15].map((heroId) => ({ heroId, score: 1, margin: 1 })),
        right: [2, 3, 4, 5].map((heroId) => ({ heroId, score: 1, margin: 1 })),
      },
    },
  });
  expect(sent.at(-1)?.advice?.ranked).toHaveLength(3);
  expect(sent.at(-1)?.advice?.rerollsRemaining).toBe(1);
  expect(onNewMatch).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Owned (1)' })).toBeTruthy();
  const opponentSelects = [1, 2, 3, 4].map(
    (i) => screen.getByRole('combobox', { name: `Enemy ${i}` }) as HTMLSelectElement,
  );
  expect(opponentSelects.map((s) => Number(s.value))).toEqual([6, 12, 13, 15]);
  const nextGame = {
    ...full,
    captureEpoch: reset.captureEpoch,
    round: 1,
    transition: 'initial' as const,
    inventory: null,
    meta: { ...full.meta!, round: 1 },
  };
  await deliver(nextGame);
  await deliver(nextGame);
  expect(onNewMatch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('heading', { name: 'Owned (0)' })).toBeTruthy();
});

it('retains the first-round team panel through the real preparation phase while item advice clears independently', async () => {
  const heroes = readJson('heroes.json') as Hero[],
    items = readJson('items.json') as Item[],
    abilities = readJson('abilities.json') as Ability[];
  const hero = heroes.find((h) => h.id === 1)!;
  const ids = ['Swift Striker', 'Quicksilver Reload', 'Spirit Shielding'].map(
    (name) => items.find((i) => i.name === name)!.id,
  );
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: () => Promise.resolve() };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getDisplayMedia: () => Promise.resolve({ getTracks: () => [track], getVideoTracks: () => [track] }),
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const props = { hero, heroes, items, abilities, onHero: () => {} };
  const view = render(<BrawlView {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listener).toBeTypeOf('function'));
  const draft: FrameResult = {
    type: 'result',
    shop: true,
    round: 1,
    choice: 3,
    accepted: true,
    transition: 'initial',
    key: ids.join(','),
    reads: ids.map((itemId, slot) => ({
      card: String(slot),
      itemId,
      present: true,
      tier: 1,
      rare: false,
      enhanced: false,
      match: { itemId, x: slot * 200, y: 200, edge: 185, score: 1, margin: 1 },
    })),
    inventory: null,
    ms: 0,
    teamRoster: { self: 1, left: [1, 2, 3, 4], right: [6, 7, 8, 10] },
    meta: {
      self: 1,
      round: 1,
      choice: 3,
      bar: {
        left: [1, 2, 3, 4].map((heroId) => ({ heroId, score: 1, margin: 1 })),
        right: [6, 7, 8, 10].map((heroId) => ({ heroId, score: 1, margin: 1 })),
      },
      rerollsRemaining: 1,
    },
  };
  const deliver = async (frame: FrameResult) => act(async () => listener!({ data: frame } as MessageEvent<WorkerOut>));
  await deliver(draft);
  await deliver({ ...draft, accepted: false });
  const edge = sent.at(-1)?.teamEdge;
  expect(edge).toBeTruthy();
  const countdown: FrameResult = {
    ...draft,
    shop: false,
    accepted: false,
    meta: null,
    teamRoster: undefined,
    reads: [],
    key: '',
    round: 0,
    choice: 0,
    roundCountdown: true,
    preparationRound: 1,
  };
  now = 100;
  await deliver(countdown);
  now = 500;
  await deliver(countdown);
  expect(sent.at(-1)).toMatchObject({
    teamVisible: true,
    teamEdge: edge,
    advice: null,
    reads: [],
    reroll: false,
    bestId: null,
  });
  now = 11_000;
  await deliver(countdown);
  expect(sent.at(-1)?.teamEdge).toEqual(edge);
  view.rerender(<BrawlView {...props} overlaySettings={{ ...DEFAULT_OVERLAY_SETTINGS, showTeamWinRates: false }} />);
  await waitFor(() => expect(sent.at(-1)?.teamEdge).toBeNull());
  view.rerender(<BrawlView {...props} overlaySettings={DEFAULT_OVERLAY_SETTINGS} />);
  await waitFor(() => expect(sent.at(-1)?.teamEdge).toEqual(edge));
  // F8 during preparation re-reads fresh cue evidence and keeps the same confirmed roster.
  await act(async () => detectRun!());
  now = 11_100;
  await deliver(countdown);
  expect(sent.at(-1)?.teamEdge).toEqual(edge);
  const gameplay = { ...countdown, roundCountdown: false, preparationRound: 0 };
  now = 11_400;
  await deliver(gameplay);
  expect(sent.at(-1)?.teamEdge).toEqual(edge);
  now = 11_700;
  await deliver(gameplay);
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  now = 12_000;
  await deliver({ ...countdown, preparationRound: 2 });
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  await deliver(countdown);
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /stop capture/i }));
  await waitFor(() => expect(sent.at(-1)?.teamEdge ?? null).toBeNull());
});
