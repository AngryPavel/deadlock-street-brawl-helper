// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlaySettingsPanel } from '../../local/OverlaySettingsPanel';
import { DEFAULT_OVERLAY_SETTINGS, isOverlaySettings } from '../../local/overlaySettings';
import { usePersisted } from '../../hooks/usePersisted';

function Settings() {
  const [settings, onChange] = usePersisted('overlaySettings', isOverlaySettings, DEFAULT_OVERLAY_SETTINGS);
  return <OverlaySettingsPanel settings={settings} onChange={onChange} />;
}

const checkbox = () => screen.getByRole('checkbox', { name: 'Show team hero win rates' }) as HTMLInputElement;
beforeEach(() => {
  localStorage.removeItem('brawl.overlaySettings');
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  localStorage.removeItem('brawl.overlaySettings');
});

describe('team win-rate display checkbox', () => {
  it('defaults to enabled, persists an opt-out across remounts, and restores it with Reset defaults', () => {
    const first = render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay settings' }));
    expect(checkbox().checked).toBe(true);
    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(false);
    first.unmount();
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay settings' }));
    expect(checkbox().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reset defaults' }));
    expect(checkbox().checked).toBe(true);
    expect(JSON.parse(localStorage.getItem('brawl.overlaySettings')!).showTeamWinRates).toBe(true);
  });

  it('preserves legacy advice and timing preferences when the new checkbox is toggled', () => {
    const legacy = { detail: 'compact', abilityTipMode: 'fixed', tipSeconds: 25, pointLimitSeconds: 80 };
    localStorage.setItem('brawl.overlaySettings', JSON.stringify(legacy));
    render(<Settings />);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay settings' }));
    expect(checkbox().checked).toBe(true);
    expect((screen.getByLabelText('Item advice') as HTMLSelectElement).value).toBe('compact');
    fireEvent.click(checkbox());
    expect(JSON.parse(localStorage.getItem('brawl.overlaySettings')!)).toEqual({ ...legacy, showTeamWinRates: false });
    fireEvent.change(screen.getByLabelText('Fixed time / unreadable HUD fallback (seconds)'), {
      target: { value: '30' },
    });
    expect(JSON.parse(localStorage.getItem('brawl.overlaySettings')!)).toEqual({
      ...legacy,
      tipSeconds: 30,
      showTeamWinRates: false,
    });
  });
});
