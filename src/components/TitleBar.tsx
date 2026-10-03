/** The control window's own title strip (the window is frameless): icon, name, minimise, close. The strip is the drag
 *  area; the buttons are not. Only rendered inside Electron. */
export function TitleBar() {
  const api = window.brawlAPI;
  if (!api) return null;
  return (
    <div className="titlebar">
      <img className="titlebar-icon" src="./apple-touch-icon.png" alt="" draggable={false} />
      <span className="titlebar-name">Deadlock Street Brawl Helper</span>
      <button className="titlebar-btn" aria-label="Minimise" onClick={() => api.minimizeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button className="titlebar-btn close" aria-label="Close" onClick={() => api.closeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
