// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataUpdates } from '../DataUpdates';
import type { BrawlApi } from '../../../electron/preload';
import type { UpdateProgress } from '../../data/updateTypes';

describe('desktop data updates', () => {
  let listener: (p: UpdateProgress) => void;
  let api: Partial<BrawlApi>;
  const manifest = { fetched_at: '2026-01-01T00:00:00Z', window_days: 30, counts: {} };
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    api = {
      getDataStatus: vi.fn(async () => ({
        baseUrl: 'brawl-data://snapshot/bundled/',
        fetchedAt: '2026-01-01T00:00:00Z',
        sincePatch: '2026-01-01T00:00:00Z',
        latestPatch: {
          title: '01/02/2026 Update',
          timestamp: Date.parse('2026-01-02T00:00:00Z') / 1000,
          url: 'https://example.com/patch',
        },
        patchCheckError: null,
        canIncrement: true,
      })),
      getDataProgress: vi.fn(async () => ({
        phase: 'idle' as const,
        stage: 'Ready',
        completed: 0,
        total: 0,
        percent: 0,
        elapsedSeconds: 0,
        etaSeconds: null,
        message: 'Ready.',
        warnings: [],
      })),
      onDataProgress: vi.fn((cb) => {
        listener = cb;
        return () => {};
      }),
      startDataUpdate: vi.fn(async () => ({
        phase: 'running' as const,
        stage: 'Catalog',
        completed: 1,
        total: 10,
        percent: 5,
        elapsedSeconds: 2,
        etaSeconds: 18,
        message: 'Downloading images.',
        warnings: [],
      })),
      cancelDataUpdate: vi.fn(),
    };
    window.brawlAPI = api as BrawlApi;
  });
  afterEach(() => {
    cleanup();
    delete window.brawlAPI;
  });
  it('shows a patch notice, English progress, and defers activation until Apply', async () => {
    const apply = vi.fn(async () => {});
    render(<DataUpdates manifest={manifest} onApply={apply} />);
    await screen.findByText(/New patch announcement found/);
    fireEvent.click(screen.getByRole('button', { name: 'Update data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download data' }));
    await waitFor(() =>
      expect(api.startDataUpdate).toHaveBeenCalledWith({ mode: 'full', since: '2026-01-02T00:00:00.000Z' }),
    );
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: 'Continue in background' }));
    expect(document.querySelector('dialog')?.open).toBe(false);
    act(() =>
      listener({
        phase: 'complete',
        stage: 'Complete',
        completed: 10,
        total: 10,
        percent: 100,
        elapsedSeconds: 20,
        etaSeconds: 0,
        message: 'Data updated.',
        warnings: [],
      }),
    );
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply updated data' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply updated data' }).at(-1)!);
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  });
  it('offers cancellation without applying partial data', async () => {
    const apply = vi.fn(async () => {});
    render(<DataUpdates manifest={manifest} onApply={apply} />);
    await screen.findByText(/New patch announcement found/);
    fireEvent.click(screen.getByRole('button', { name: 'Update data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download data' }));
    await screen.findByRole('button', { name: 'Cancel update' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel update' }));
    expect(api.cancelDataUpdate).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
});
