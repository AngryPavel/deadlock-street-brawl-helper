// @vitest-environment jsdom
// Electron-only capture-denied path: BrawlView reads `window.brawlAPI`, so it must exist before the
// module under test is imported (isElectron is computed once at module scope).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Ability, Hero, Item } from '../../types';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
}));

let onCaptureDeniedCb: (() => void) | undefined;
type CaptureState = { wanted: boolean; probe: boolean };
let onCaptureStateCb: ((st: CaptureState) => void) | undefined;
let captureState: CaptureState = { wanted: false, probe: false };
const captureIdle = vi.fn();

(window as unknown as { brawlAPI: unknown }).brawlAPI = {
  isElectron: true,
  getGameRect: () => Promise.resolve(null),
  onGameRect: () => () => {},
  getCaptureState: () => Promise.resolve(captureState),
  onCaptureState: (cb: typeof onCaptureStateCb) => {
    onCaptureStateCb = cb;
    return () => {
      onCaptureStateCb = undefined;
    };
  },
  captureIdle,
  sendOverlayState: () => {},
  onOverlayState: () => () => {},
  onCaptureDenied: (cb: () => void) => {
    onCaptureDeniedCb = cb;
    return () => {
      onCaptureDeniedCb = undefined;
    };
  },
  onTestMode: () => () => {},
  getTestMode: () => Promise.resolve({ on: false, frame: '', frames: [], message: null }),
  getPlatformWarning: () => Promise.resolve(null),
};

// jsdom has no Worker; BrawlView only needs postMessage/terminate to exist for these tests.
(globalThis as unknown as { Worker: unknown }).Worker = class {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
};

const { BrawlView } = await import('../BrawlView');

afterEach(cleanup);

describe('BrawlView (Electron capture-denied)', () => {
  beforeEach(() => {
    onCaptureDeniedCb = undefined;
    onCaptureStateCb = undefined;
    captureState = { wanted: false, probe: false };
    let calls = 0;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getDisplayMedia: vi.fn(() => {
        calls++;
        // main.ts sends the capture-denied IPC just before the renderer's getDisplayMedia() promise rejects
        onCaptureDeniedCb?.();
        const err = new DOMException('Error starting capture', 'AbortError');
        return Promise.reject(err);
      }),
    };
    (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls = () => calls;
  });

  it('shows "Deadlock window not found" and does not clear it, and does not retry while capture is not wanted', async () => {
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero = heroes.find((h) => h.id === 1)!;

    render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Deadlock window not found'));

    const calls = () => (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls();
    const after1 = calls();
    // simulate state ticks that never want capture (no game): must not retry
    onCaptureStateCb?.({ wanted: false, probe: false });
    onCaptureStateCb?.({ wanted: false, probe: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls()).toBe(after1);
    expect(screen.getByRole('status').textContent).toContain('Deadlock window not found');
  });

  it('retries once the game window is found after a denial', async () => {
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero = heroes.find((h) => h.id === 1)!;

    render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Deadlock window not found'));

    const calls = () => (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls();
    const before = calls();
    onCaptureStateCb?.({ wanted: true, probe: false });
    await waitFor(() => expect(calls()).toBe(before + 1));
  });

  it('shows "capture failed: <message>" for an AbortError that is not accompanied by the capture-denied IPC', async () => {
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      // Same AbortError shape as a real denial, but main.ts never sent the capture-denied IPC for it —
      // must not be guessed as a denial from the error's name/message alone.
      getDisplayMedia: vi.fn(() => Promise.reject(new DOMException('Error starting capture', 'AbortError'))),
    };
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    const hero = heroes.find((h) => h.id === 1)!;

    render(<BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={() => {}} />);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('capture failed:'));
    expect(screen.getByRole('status').textContent).not.toContain('Deadlock window not found');
  });
});

describe('BrawlView (Electron, real game: capture only around the draft)', () => {
  const props = () => {
    const heroes = readJson('heroes.json') as Hero[];
    const items = readJson('items.json') as Item[];
    const abilities = readJson('abilities.json') as Ability[];
    return { hero: heroes.find((h) => h.id === 1)!, heroes, items, abilities, onHero: () => {} };
  };
  const calls = () => (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls();

  beforeEach(() => {
    onCaptureStateCb = undefined;
    captureIdle.mockClear();
    captureState = { wanted: false, probe: true };
    let n = 0;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getDisplayMedia: vi.fn(() => {
        n++;
        return Promise.reject(new DOMException('nope', 'AbortError'));
      }),
    };
    (window as unknown as { __getDisplayMediaCalls: () => number }).__getDisplayMediaCalls = () => n;
  });

  it('does not start capturing until main.ts says the draft probe hit', async () => {
    render(<BrawlView {...props()} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Deadlock window not found'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(0);
    onCaptureStateCb?.({ wanted: true, probe: true });
    await waitFor(() => expect(calls()).toBe(1));
  });

  it('shows Detect now (F8) beside Start capture, disabled with "Deadlock not found" without a game rect', async () => {
    const { container } = render(<BrawlView {...props()} />);
    await new Promise((r) => setTimeout(r, 50));
    const detect = screen.getByRole('button', { name: /detect now \(f8\)/i }) as HTMLButtonElement;
    const start = screen.getByRole('button', { name: /start capture/i });
    expect(detect.disabled).toBe(true);
    expect(detect.parentElement).toBe(start.parentElement);
    expect(container.textContent).toContain('Deadlock not found');
  });

  it('renders only the capture button, status line and how-to when Debug is hidden', async () => {
    const { container } = render(<BrawlView {...props()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('button', { name: /start capture/i })).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(container.textContent).toContain('Borderless Windowed');
    expect(container.querySelectorAll('select').length).toBe(0);
    expect(container.textContent).not.toMatch(/top items|Owned|Cards on screen|Ability order|Round|Debug/);
    expect(container.querySelector('.chip, canvas, .brawl-preview, img')).toBeNull();
  });
});
