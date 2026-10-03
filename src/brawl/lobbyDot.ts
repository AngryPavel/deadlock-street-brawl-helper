// When the status dot shows: while the player is not in a match. Pure state machine (time passed in), like
// abilityPanelTimer.ts, so it is unit-testable without a clock or Windows.

/** No draft for this long means the match is over and the player is back in the lobby. */
export const LOBBY_AFTER_MS = 10 * 60_000;

export interface LobbyState {
  found: boolean; // the Deadlock window exists
  inMatch: boolean; // a draft was recognised and the 10 minute lobby timeout has not passed since the last one
  lastDraftAt: number | null;
}

export const initialLobby = (): LobbyState => ({ found: false, inMatch: false, lastDraftAt: null });

export type LobbyEvent = { type: 'tick'; found: boolean; now: number } | { type: 'draft'; now: number };

export function stepLobby(s: LobbyState, ev: LobbyEvent): LobbyState {
  if (ev.type === 'draft') {
    if (s.inMatch && s.lastDraftAt === ev.now) return s;
    return { found: true, inMatch: true, lastDraftAt: ev.now };
  }
  // Window lost (and later found again = Deadlock restarted): back to the lobby.
  if (!ev.found) return s.found || s.inMatch ? initialLobby() : s;
  let { inMatch, lastDraftAt } = s;
  if (inMatch && lastDraftAt !== null && ev.now - lastDraftAt >= LOBBY_AFTER_MS) {
    inMatch = false;
    lastDraftAt = null;
  }
  if (s.found && inMatch === s.inMatch) return s;
  return { found: true, inMatch, lastDraftAt };
}

/** The dot is drawn when the window exists, no match is running, and Deadlock is the foreground window. */
export const lobbyDotVisible = (s: LobbyState, foreground: boolean): boolean => s.found && !s.inMatch && foreground;

export type DotState = 'watching' | 'reading' | 'failed';
export const DOT_TEXT: Record<DotState, string> = {
  watching: 'Brawl Helper: watching for draft. F8 = detect now',
  reading: 'Brawl Helper: reading draft. F8 = detect now',
  failed: 'Brawl Helper: capture failed. F8 = detect now',
};
export const dotState = (o: { captureFailed: boolean; capturing: boolean }): DotState =>
  o.captureFailed ? 'failed' : o.capturing ? 'reading' : 'watching';
