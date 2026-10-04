import { useEffect, useRef, useState } from 'react';
import type { Manifest } from '../data/load';
import type { DataStatus, UpdateProgress } from '../data/updateTypes';

export function DataUpdates({ manifest, onApply }: { manifest: Manifest | null; onApply: () => Promise<void> }) {
  const api = window.brawlAPI;
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState('');
  const [mode, setMode] = useState<'full' | 'incremental'>('incremental');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = progress?.phase === 'running';
  const enabled = !!api?.getDataStatus;
  const refresh = async (check = true) => {
    if (!api?.getDataStatus) return;
    setChecking(true);
    try {
      setStatus(await api.getDataStatus(check));
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (!api?.getDataStatus) return;
    let alive = true;
    void api
      .getDataStatus(true)
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    void api.getDataProgress().then((p) => {
      if (alive && p.phase !== 'idle') setProgress(p);
    });
    const off = api.onDataProgress((p) => {
      setProgress(p);
      setMessages((previous) => (previous.at(-1) === p.message ? previous : [...previous.slice(-19), p.message]));
      if (p.phase === 'complete') void refresh(false);
    });
    const timer = setInterval(() => void refresh(), 30 * 60 * 1000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- desktop API is fixed for this window
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);
  const fetched = status?.fetchedAt ?? manifest?.brawl?.fetched_at ?? manifest?.fetched_at;
  const patch = status?.latestPatch;
  const boundary = status?.sincePatch ? Date.parse(status.sincePatch) : null;
  const newer =
    !!patch &&
    (boundary !== null ? patch.timestamp * 1000 > boundary : patch.timestamp * 1000 > Date.parse(fetched ?? ''));
  const mixed = !!patch && boundary === null;
  const age = fetched ? Math.max(0, Math.floor((Date.now() - Date.parse(fetched)) / 86400000)) : null;
  const notice = newer
    ? 'New patch announcement found. Collect a fresh post-patch snapshot.'
    : mixed
      ? 'This snapshot may include pre-patch games. Collect data from a confirmed patch time.'
      : age !== null && age >= 7
        ? `Data has not been updated for ${age} days.`
        : fetched
          ? `Data updated ${new Date(fetched).toLocaleDateString('en-GB')}.`
          : 'No snapshot date available.';
  const show = () => {
    const date =
      (newer && patch ? new Date(patch.timestamp * 1000).toISOString() : status?.sincePatch) ??
      (patch
        ? new Date(patch.timestamp * 1000).toISOString()
        : new Date(
            (manifest?.brawl?.min_unix_timestamp ?? Math.floor(Date.now() / 1000) - 30 * 86400) * 1000,
          ).toISOString());
    setSince(date.slice(0, 16));
    setMode(newer || !status?.canIncrement ? 'full' : 'incremental');
    setOpen(true);
    setError('');
  };
  const start = async () => {
    if (!api) return;
    setError('');
    setMessages([]);
    try {
      setProgress(await api.startDataUpdate({ mode, since: new Date(`${since}Z`).toISOString() }));
    } catch (e) {
      setError(String(e));
    }
  };
  const apply = async () => {
    setApplying(true);
    setError('');
    try {
      await onApply();
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };
  return (
    <>
      <section
        className={`data-updates ${newer || mixed || (age !== null && age >= 7) ? 'needs-update' : ''}`}
        aria-label="Data updates"
      >
        <div>
          <span>{notice}</span>
          {status?.patchCheckError && <small>{status.patchCheckError}</small>}
        </div>
        <button
          className="btn"
          disabled={!enabled}
          onClick={show}
          title={!enabled ? 'Data updates are available in the Windows app.' : undefined}
        >
          {busy ? 'View update progress' : progress?.phase === 'complete' ? 'Apply updated data' : 'Update data'}
        </button>
      </section>
      <dialog
        ref={dialog}
        className="data-update-dialog"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        aria-labelledby="data-update-title"
      >
        <h2 id="data-update-title">Update Street Brawl data</h2>
        <p>Keep playing while the snapshot downloads. Your current data stays active until you apply the update.</p>
        {patch && (
          <p>
            Latest patch announcement:{' '}
            <a href={patch.url} target="_blank" rel="noreferrer">
              {patch.title}
            </a>{' '}
            · {new Date(patch.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC
          </p>
        )}
        <p className="muted">
          Steam announcement times may differ from deployment times. Confirm or adjust the patch time below. Analytics
          start at the next full hour.
        </p>
        <label>
          Patch time (UTC)
          <input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} disabled={busy} />
        </label>
        <label>
          Update mode
          <select value={mode} onChange={(e) => setMode(e.target.value as 'full' | 'incremental')} disabled={busy}>
            <option value="incremental">Add recent data</option>
            <option value="full">Rebuild all post-patch data</option>
          </select>
        </label>
        <p className="muted">
          A new patch or changed hero roster automatically requires a full rebuild. Recent batches are replaced to avoid
          counting matches twice.
        </p>
        {progress && (
          <div className="data-update-progress" aria-live="polite">
            <strong>
              {progress.stage} · {progress.percent}%
            </strong>
            <progress max={100} value={progress.percent} />
            <div>
              {progress.completed}/{progress.total} in this stage · elapsed {progress.elapsedSeconds}s
              {progress.etaSeconds !== null ? ` · stage ETA ~${progress.etaSeconds}s` : ''}
            </div>
            <p>{progress.message}</p>
            <ol className="data-update-log">
              {messages.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ol>
            {!!progress.warnings.length && (
              <details>
                <summary>Image warnings ({progress.warnings.length})</summary>
                <ul>
                  {progress.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="data-update-actions">
          <button className="btn" onClick={() => setOpen(false)}>
            {busy ? 'Continue in background' : 'Close'}
          </button>
          {!busy && (
            <button className="btn" disabled={checking || applying} onClick={() => void refresh()}>
              {checking ? 'Checking…' : 'Check for patches'}
            </button>
          )}
          {busy ? (
            <button className="btn" onClick={() => void api?.cancelDataUpdate()}>
              Cancel update
            </button>
          ) : progress?.phase === 'complete' ? (
            <button className="btn primary" disabled={applying} onClick={() => void apply()}>
              {applying ? 'Applying…' : 'Apply updated data'}
            </button>
          ) : (
            <button className="btn primary" disabled={!since || applying} onClick={() => void start()}>
              Download data
            </button>
          )}
        </div>
      </dialog>
    </>
  );
}
