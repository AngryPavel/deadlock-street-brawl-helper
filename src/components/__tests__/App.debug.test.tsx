// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../App';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

vi.mock('../../data/load', () => ({
  j: (rel: string) => Promise.resolve(readJson(rel)),
  img: (p?: string) => p,
  loadCore: () =>
    Promise.resolve([
      readJson('items.json'),
      readJson('heroes.json'),
      readJson('abilities.json'),
      readJson('manifest.json'),
    ]),
}));

afterEach(cleanup);

describe('App Debug panel', () => {
  it('persists detailed/compact advice and both ability-tip time controls across launches', async () => {
    localStorage.removeItem('brawl.overlaySettings');
    const first = render(<App />);
    await screen.findByRole('button', { name: 'Overlay settings' });
    fireEvent.change(screen.getByLabelText('Item advice'), { target: { value: 'compact' } });
    fireEvent.change(screen.getByLabelText('Ability upgrade tip'), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByLabelText('Fixed time / unreadable HUD fallback (seconds)'), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByLabelText('Maximum time in HUD points mode (seconds)'), { target: { value: '80' } });
    first.unmount();
    render(<App />);
    await screen.findByRole('button', { name: 'Overlay settings' });
    expect((screen.getByLabelText('Item advice') as HTMLSelectElement).value).toBe('compact');
    expect((screen.getByLabelText('Ability upgrade tip') as HTMLSelectElement).value).toBe('fixed');
    expect((screen.getByLabelText('Fixed time / unreadable HUD fallback (seconds)') as HTMLInputElement).value).toBe(
      '25',
    );
    expect((screen.getByLabelText('Maximum time in HUD points mode (seconds)') as HTMLInputElement).value).toBe('80');
    localStorage.removeItem('brawl.overlaySettings');
  });
  it('is hidden at start and Ctrl+Shift+D toggles it', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /start capture/i });
    expect(screen.queryByLabelText('Debug panel')).toBeNull();
    fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByLabelText('Debug panel')).toBeTruthy());
    expect(screen.getByLabelText('Round')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByLabelText('Debug panel')).toBeNull());
  });
});
