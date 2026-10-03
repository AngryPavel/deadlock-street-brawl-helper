import { describe, expect, it } from 'vitest';
import { LOBBY_AFTER_MS, initialLobby, lobbyDotVisible, stepLobby, dotState } from '../lobbyDot';
import { shouldRegisterDetectKey } from '../../../electron/detectKey';

describe('lobby dot', () => {
  it('is shown once the window is found, only while foreground', () => {
    let s = initialLobby();
    expect(lobbyDotVisible(s, true)).toBe(false);
    s = stepLobby(s, { type: 'tick', found: true, now: 0 });
    expect(lobbyDotVisible(s, true)).toBe(true);
    expect(lobbyDotVisible(s, false)).toBe(false);
  });
  it('hides on the first recognised draft', () => {
    let s = stepLobby(initialLobby(), { type: 'tick', found: true, now: 0 });
    s = stepLobby(s, { type: 'draft', now: 1000 });
    expect(lobbyDotVisible(s, true)).toBe(false);
    s = stepLobby(s, { type: 'tick', found: true, now: 5000 });
    expect(lobbyDotVisible(s, true)).toBe(false);
  });
  it('comes back after 10 minutes without a draft, and a new draft restarts the clock', () => {
    let s = stepLobby(initialLobby(), { type: 'tick', found: true, now: 0 });
    s = stepLobby(s, { type: 'draft', now: 1000 });
    s = stepLobby(s, { type: 'draft', now: 400_000 });
    s = stepLobby(s, { type: 'tick', found: true, now: 400_000 + LOBBY_AFTER_MS - 1 });
    expect(lobbyDotVisible(s, true)).toBe(false);
    s = stepLobby(s, { type: 'tick', found: true, now: 400_000 + LOBBY_AFTER_MS });
    expect(lobbyDotVisible(s, true)).toBe(true);
  });
  it('comes back when the window is lost and found again', () => {
    let s = stepLobby(initialLobby(), { type: 'tick', found: true, now: 0 });
    s = stepLobby(s, { type: 'draft', now: 1000 });
    s = stepLobby(s, { type: 'tick', found: false, now: 2000 });
    expect(lobbyDotVisible(s, true)).toBe(false);
    s = stepLobby(s, { type: 'tick', found: true, now: 3000 });
    expect(lobbyDotVisible(s, true)).toBe(true);
  });
  it('picks the dot colour state', () => {
    expect(dotState({ captureFailed: false, capturing: false })).toBe('watching');
    expect(dotState({ captureFailed: false, capturing: true })).toBe('reading');
    expect(dotState({ captureFailed: true, capturing: true })).toBe('failed');
  });
});

describe('F8 registration', () => {
  it('registers only while a game window exists', () => {
    expect(shouldRegisterDetectKey(true, false)).toBe('register');
    expect(shouldRegisterDetectKey(true, true)).toBe('keep');
    expect(shouldRegisterDetectKey(false, true)).toBe('unregister');
    expect(shouldRegisterDetectKey(false, false)).toBe('keep');
  });
});
