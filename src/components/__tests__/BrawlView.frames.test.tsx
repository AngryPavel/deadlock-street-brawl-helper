// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FrameResult, WorkerOut, WorkerIn } from '../../brawl/worker';
import type { OverlayState } from '../../brawl/draw';
import type { Ability, Hero, Item } from '../../types';
import { DEFAULT_OVERLAY_SETTINGS } from '../../local/overlaySettings';
import { useState } from 'react';
import { useAutoHero } from '../../hooks/useAutoHero';

const readJson = (rel: string) =>
  JSON.parse(readFileSync(path.resolve(__dirname, '../../../public/data', rel), 'utf8'));
let delayedTierData: Promise<unknown> | null = null;
vi.mock('../../data/load', () => ({
  j: (rel: string) =>
    rel === 'analytics/brawl/tier-list.json' && delayedTierData ? delayedTierData : Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
}));
let listener: ((event: MessageEvent<WorkerOut>) => void) | undefined;
const sent: OverlayState[] = [];
const workerMessages: WorkerIn[] = [];
let detectRun: (() => void) | undefined;
let captureProbe = false;
const captureIdle = vi.fn();
(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  getGameRect: () => Promise.resolve(null),
  onGameRect: () => () => {},
  onDetectRun: (cb: () => void) => {
    detectRun = cb;
    return () => {
      detectRun = undefined;
    };
  },
  getCaptureState: () => Promise.resolve({ wanted: false, probe: captureProbe }),
  onCaptureState: () => () => {},
  onCaptureDenied: () => () => {},
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
  sendOverlayState: (state: OverlayState) => sent.push(structuredClone(state)),
  captureIdle,
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

it('applies confirmed identity while cards are blocked, preserves manual choice and purchases, and releases them only on a confirmed new match', async () => {
  const heroes = readJson('heroes.json') as Hero[],
    items = readJson('items.json') as Item[],
    abilities = readJson('abilities.json') as Ability[];
  const onNewMatch = vi.fn();
  function Harness() {
    const [id, setId] = useState(1);
    const automatic = useAutoHero(setId);
    return (
      <>
        <output aria-label="Selected test hero">{id}</output>
        <button onClick={() => automatic.choose(1, 'manual')}>Manual test hero</button>
        <BrawlView
          debug
          hero={heroes.find((h) => h.id === id)!}
          heroes={heroes}
          items={items}
          abilities={abilities}
          onHero={automatic.choose}
          onNewMatch={(heroId) => {
            automatic.newMatch(heroId);
            onNewMatch(heroId);
          }}
        />
      </>
    );
  }
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: () => Promise.resolve() };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getDisplayMedia: () => Promise.resolve({ getTracks: () => [track], getVideoTracks: () => [track] }),
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listener).toBeTypeOf('function'));
  const packet = (
    self: number,
    foes: number[],
    round: number,
    metadataSample: number,
    transition: 'metadata' | 'hero' = 'metadata',
  ): FrameResult => ({
    type: 'result',
    identityOnly: true,
    metadataSample,
    pending: true,
    shop: true,
    round,
    choice: 2,
    accepted: false,
    transition,
    key: '',
    reads: [],
    inventory: null,
    ms: 0,
    meta: {
      self,
      round,
      choice: 2,
      rerollsRemaining: -1,
      bar: {
        left: [self].map((heroId) => ({ heroId, score: 1, margin: 1 })),
        right: foes.map((heroId) => ({ heroId, score: 1, margin: 1 })),
      },
    },
  });
  const deliver = async (frame: FrameResult) => act(async () => listener!({ data: frame } as MessageEvent<WorkerOut>));
  await deliver(packet(67, [2, 3, 4, 5], 1, 1));
  expect(screen.getByLabelText('Selected test hero').textContent).toBe('67');
  await deliver(packet(67, [2, 3, 4, 5], 1, 2));
  fireEvent.click(screen.getByRole('button', { name: 'Manual test hero' }));
  const owned = items.find((i) => i.name === 'Extra Stamina')!.id;
  await deliver({ ...packet(67, [2, 3, 4, 5], 1, 3), identityOnly: false, meta: null, inventory: [owned] });
  expect(screen.getByText(/Owned \(1\)/)).toBeTruthy();
  const preparation = { shop: false, roundCountdown: true, preparationRound: 1 };
  await deliver({ ...packet(76, [67, 10, 11, 0], 1, 4, 'hero'), ...preparation });
  await deliver({ ...packet(76, [67, 10, 11, 12], 1, 5, 'hero'), ...preparation });
  expect(screen.getByLabelText('Selected test hero').textContent).toBe('1');
  expect(screen.getByText(/Owned \(1\)/)).toBeTruthy();
  expect(onNewMatch).not.toHaveBeenCalled();
  // An actual later round establishes the boundary; its next confirmed ROUND1 must still reset.
  await deliver(packet(76, [67, 10, 11, 12], 2, 6));
  const fresh = packet(67, [6, 7, 8, 9], 1, 7);
  await deliver(fresh);
  await deliver(fresh); // duplicate publication from one capture is insufficient
  expect(screen.getByLabelText('Selected test hero').textContent).toBe('1');
  expect(screen.getByText(/Owned \(1\)/)).toBeTruthy();
  await deliver({ ...fresh, metadataSample: 8 });
  expect(screen.getByLabelText('Selected test hero').textContent).toBe('67');
  expect(screen.getByText(/Owned \(0\)/)).toBeTruthy();
  expect(onNewMatch).toHaveBeenCalledOnce();
  expect(sent.every((state) => state.advice === null && state.reads.length === 0)).toBe(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sent.length = 0;
  workerMessages.length = 0;
  detectRun = undefined;
  listener = undefined;
  delayedTierData = null;
  captureProbe = false;
  captureIdle.mockClear();
  vi.useRealTimers();
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
  await waitFor(() => expect(sent.at(-1)?.teamEdge ?? null).toBeNull());
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

it('keeps capture alive beyond the idle grace while a draft is pending, then stops after a sustained non-shop screen', async () => {
  captureProbe = true;
  const heroes = readJson('heroes.json') as Hero[],
    items = readJson('items.json') as Item[],
    abilities = readJson('abilities.json') as Ability[];
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: () => Promise.resolve() };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getDisplayMedia: () => Promise.resolve({ getTracks: () => [track], getVideoTracks: () => [track] }),
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  render(
    <BrawlView
      hero={heroes.find((h) => h.id === 1)!}
      heroes={heroes}
      items={items}
      abilities={abilities}
      onHero={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listener).toBeTypeOf('function'));
  const pending: FrameResult = {
    type: 'result',
    shop: true,
    round: 2,
    choice: 2,
    accepted: false,
    pending: true,
    reads: [],
    key: '',
    meta: null,
    inventory: null,
    ms: 0,
  };
  await act(async () => listener!({ data: pending } as MessageEvent<WorkerOut>));
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(track.stop).not.toHaveBeenCalled();
  expect(captureIdle).not.toHaveBeenCalled();
  expect(screen.getByText('Draft — reading items…')).toBeTruthy();
  await act(async () =>
    listener!({
      data: {
        ...pending,
        pendingTransition: true,
        itemReadStatus: { confirmed: 2, phase: 'unknown', unresolved: [1] },
      },
    } as MessageEvent<WorkerOut>),
  );
  expect(screen.getByText('Draft — top name unread (2/3); reveal the names or press F8')).toBeTruthy();
  expect(sent.at(-1)?.advice).toBeNull();
  expect(sent.at(-1)?.reads).toHaveLength(0);
  await act(async () =>
    listener!({
      data: { ...pending, captureEpoch: -1, itemReadStatus: { confirmed: 0, phase: 'reading', unresolved: [0, 1, 2] } },
    } as MessageEvent<WorkerOut>),
  );
  expect(screen.getByText('Draft — top name unread (2/3); reveal the names or press F8')).toBeTruthy();
  await act(async () => listener!({ data: { ...pending, shop: false, pending: false } } as MessageEvent<WorkerOut>));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(track.stop).toHaveBeenCalledOnce();
  expect(captureIdle).toHaveBeenCalledOnce();
});
it('publishes first preparation and a partial roster before item acceptance, then fills rates when data arrives', async () => {
  const heroes = readJson('heroes.json') as Hero[],
    items = readJson('items.json') as Item[],
    abilities = readJson('abilities.json') as Ability[];
  let load!: (value: unknown) => void;
  delayedTierData = new Promise((resolve) => {
    load = resolve;
  });
  const track = { stop: vi.fn(), addEventListener: vi.fn(), applyConstraints: () => Promise.resolve() };
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getDisplayMedia: () => Promise.resolve({ getTracks: () => [track], getVideoTracks: () => [track] }),
  };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const props = { hero: heroes.find((h) => h.id === 76)!, heroes, items, abilities, onHero: vi.fn() };
  const view = render(<BrawlView {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /start capture/i }));
  await waitFor(() => expect(listener).toBeTypeOf('function'));
  const pending: FrameResult = {
    type: 'result',
    shop: true,
    round: 1,
    choice: 3,
    identityOnly: true,
    accepted: false,
    pending: true,
    reads: [],
    key: '',
    meta: null,
    inventory: null,
    ms: 0,
    preparationRound: 1,
    roundCountdown: true,
    teamRoster: { self: 76, left: [76, 65, 67, 0], right: [79, 27, 84, 1] },
  };
  const deliver = async (frame: FrameResult) => act(async () => listener!({ data: frame } as MessageEvent<WorkerOut>));
  await deliver(pending);
  expect(sent.at(-1)).toMatchObject({
    teamVisible: true,
    advice: null,
    reads: [],
    teamEdge: { ownWinRate: null, deltaPp: null },
  });
  expect(sent.at(-1)?.teamEdge?.ownHeroes[3]).toMatchObject({ name: 'Reading hero', unavailable: 'reading-hero' });
  expect(sent.at(-1)?.teamEdge?.ownHeroes[0]).toMatchObject({
    name: props.hero.name,
    winRate: null,
    unavailable: 'loading-data',
  });
  expect(screen.getByText('Draft — reading items…')).toBeTruthy();
  await act(async () => load(readJson('analytics/brawl/tier-list.json')));
  await waitFor(() => expect(sent.at(-1)?.teamEdge?.ownHeroes[0]?.winRate).toEqual(expect.any(Number)));
  expect(sent.at(-1)?.teamEdge?.deltaPp).toBeNull();
  // A regular pending output must also update independently of the unpublished card tuple.
  await deliver({
    ...pending,
    identityOnly: false,
    teamRoster: { ...pending.teamRoster!, left: [76, 65, 67, 2], right: [79, 27, 6, 1] },
  });
  expect(sent.at(-1)?.teamEdge?.deltaPp).toEqual(expect.any(Number));
  view.rerender(<BrawlView {...props} overlaySettings={{ ...DEFAULT_OVERLAY_SETTINGS, showTeamWinRates: false }} />);
  await waitFor(() => expect(sent.at(-1)?.teamEdge ?? null).toBeNull());
  view.rerender(<BrawlView {...props} overlaySettings={DEFAULT_OVERLAY_SETTINGS} />);
  await waitFor(() => expect(sent.at(-1)?.teamVisible).toBe(true));
  await deliver({ ...pending, preparationRound: 2, preparationSample: 10 });
  await deliver({ ...pending, preparationRound: 2, preparationSample: 11 });
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  await deliver(pending);
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  expect(sent.every((s) => s.advice === null && s.reads.length === 0)).toBe(true);
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
  now = 11_800;
  await deliver(countdown);
  expect(sent.at(-1)?.teamEdge).toEqual(edge);
  now = 12_000;
  await deliver({ ...countdown, preparationRound: 2, preparationSample: 10 });
  await deliver({ ...countdown, preparationRound: 2, preparationSample: 11 });
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  await deliver(countdown);
  expect(sent.at(-1)?.teamEdge ?? null).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /stop capture/i }));
  await waitFor(() => expect(sent.at(-1)?.teamEdge ?? null).toBeNull());
});
