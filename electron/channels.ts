// IPC channel names shared by main and preload, so a typo in one shows up at compile time in both.
export const CHANNELS = {
  getGameRect: 'get-game-rect',
  gameRect: 'game-rect',
  overlayState: 'overlay-state',
  captureDenied: 'capture-denied',
  // Test mode (dummy "Deadlock" window): invoke to read/toggle/switch frame, and a push of the state to the
  // control window whenever it changes (including the dummy being closed or a real game taking over).
  testModeGet: 'test-mode-get',
  testModeSet: 'test-mode-set',
  testModeFrame: 'test-mode-frame',
  testModeState: 'test-mode-state',
  // Whether the control window should be capturing the game right now: main.ts probes for the draft screen with a
  // tiny screen-region read and only turns capture on while it is up. The control window reports back when it is done.
  captureStateGet: 'capture-state-get',
  captureState: 'capture-state',
  captureIdle: 'capture-idle',
  platformWarning: 'platform-warning',
  // Tray menu "Debug panel" entry: main -> control window, toggles the hidden Debug panel.
  debugToggle: 'debug-toggle',
} as const;
