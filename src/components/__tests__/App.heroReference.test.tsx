// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../App';

const root = path.resolve(__dirname, '../../../public/data/');
const readJson = (relative: string) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
vi.mock('../../data/load', () => ({
  j: (relative: string) => Promise.resolve(readJson(relative)),
  img: (p?: string) => p,
  loadCore: () =>
    Promise.resolve([
      readJson('items.json'),
      readJson('heroes.json'),
      readJson('abilities.json'),
      readJson('manifest.json'),
    ]),
}));

beforeEach(() => {
  localStorage.setItem('brawl.heroId', '1');
  localStorage.setItem('brawl.tab', '"advisor"');
});
afterEach(() => {
  cleanup();
  localStorage.removeItem('brawl.heroId');
  localStorage.removeItem('brawl.tab');
});

describe('selected hero reference', () => {
  it('shows item suggestions and ability upgrades below capture controls with capture off and debug closed', async () => {
    render(<App />);
    const reference = await screen.findByRole('region', { name: 'Infernus reference' });
    await waitFor(() => expect(reference.querySelectorAll('.tile').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Start capture' })).toBeTruthy();
    expect(reference.previousElementSibling?.classList.contains('brawl-controls')).toBe(true);
    expect(within(reference).getByRole('heading', { name: "Infernus's top items" })).toBeTruthy();
    expect(within(reference).getByRole('heading', { name: 'Ability order' })).toBeTruthy();
    expect(within(reference).getByRole('img', { name: 'Ability points, round 1' })).toBeTruthy();
    expect(reference.querySelector('.brawl-ability-order')!.children.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Debug panel')).toBeNull();

    fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true });
    await screen.findByLabelText('Debug panel');
    expect(screen.getAllByRole('heading', { name: 'Ability order' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: "Infernus's top items" })).toHaveLength(1);
  });

  it('refreshes reference content when the selected hero changes without starting capture', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Infernus reference' });
    const seven = readJson('heroes.json').find((hero: { name: string }) => hero.name === 'Seven');
    fireEvent.change(screen.getByRole('combobox', { name: 'Select hero' }), { target: { value: seven.id } });
    const reference = await screen.findByRole('region', { name: 'Seven reference' });
    await waitFor(() => expect(reference.querySelectorAll('.tile').length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: "Infernus's top items" })).toBeNull();
    expect(within(reference).getByRole('heading', { name: "Seven's top items" })).toBeTruthy();
    expect(reference.querySelector('.brawl-ability-order')!.children.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Start capture' })).toBeTruthy();
  });

  it('keeps both app actions and the data notice inside the hero header', async () => {
    const { container } = render(<App />);
    const settings = await screen.findByRole('button', { name: 'Overlay settings' });
    const update = screen.getByRole('button', { name: 'Update data' });
    expect(settings.closest('header')).toBeTruthy();
    expect(update.closest('header')).toBe(settings.closest('header'));
    expect(settings.closest('.header-actions')).toBe(update.closest('.header-actions'));
    expect(container.querySelector('header .data-updates > div')?.textContent).toMatch(/Data updated|Data has not/);
    expect(container.querySelectorAll('.data-updates')).toHaveLength(1);
  });
});
