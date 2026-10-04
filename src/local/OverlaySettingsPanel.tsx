import { useRef } from 'react';
import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from './overlaySettings';
import './OverlaySettingsPanel.css';

export function OverlaySettingsPanel({
  settings,
  onChange,
}: {
  settings: OverlaySettings;
  onChange: (value: OverlaySettings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const change = (value: Partial<OverlaySettings>) => onChange({ ...DEFAULT_OVERLAY_SETTINGS, ...settings, ...value });
  return (
    <div className="overlay-settings">
      <button className="btn" onClick={() => dialog.current?.showModal()}>
        Overlay settings
      </button>
      <dialog ref={dialog} className="data-update-dialog overlay-settings-dialog">
        <h2>Overlay settings</h2>
        <label className="overlay-checkbox-setting">
          <input
            type="checkbox"
            checked={settings.showTeamWinRates !== false}
            onChange={(e) => change({ showTeamWinRates: e.target.checked })}
            aria-describedby="team-win-rates-setting-description"
          />
          <span>Show team hero win rates</span>
        </label>
        <p id="team-win-rates-setting-description" className="muted">
          Shown during the first draft of round 1 when both teams have been confirmed.
        </p>
        <label>
          Item advice
          <select
            value={settings.detail}
            onChange={(e) => change({ detail: e.target.value as OverlaySettings['detail'] })}
          >
            <option value="detailed">Detailed advice</option>
            <option value="compact">Compact advice</option>
          </select>
        </label>
        <label>
          Ability upgrade tip
          <select
            value={settings.abilityTipMode}
            onChange={(e) => change({ abilityTipMode: e.target.value as OverlaySettings['abilityTipMode'] })}
          >
            <option value="points">Follow HUD points</option>
            <option value="fixed">Fixed display time</option>
          </select>
        </label>
        <label>
          Fixed time / unreadable HUD fallback (seconds)
          <input
            type="number"
            min={5}
            max={120}
            value={settings.tipSeconds}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 5 && n <= 120) change({ tipSeconds: n });
            }}
          />
        </label>
        <label>
          Maximum time in HUD points mode (seconds)
          <input
            type="number"
            min={5}
            max={180}
            value={settings.pointLimitSeconds}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 5 && n <= 180) change({ pointLimitSeconds: n });
            }}
          />
        </label>
        <p className="muted">
          Ability-tip settings apply after the next Street Brawl draft. Two matching reads confirm the counter. Zero,
          the lobby infinity symbol, or no affordable upgrades hide the tip. Unreadable counters use the fallback time;
          positive counters never exceed the maximum time.
        </p>
        <div className="data-update-actions">
          <button className="btn" onClick={() => onChange({ ...DEFAULT_OVERLAY_SETTINGS })}>
            Reset defaults
          </button>
          <button className="btn primary" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      </dialog>
    </div>
  );
}
