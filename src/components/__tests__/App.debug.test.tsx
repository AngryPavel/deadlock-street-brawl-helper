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
