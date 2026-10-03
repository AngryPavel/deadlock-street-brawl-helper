import { contextBridge, ipcRenderer } from 'electron';
import type { Rect } from './gameWindow';
import type { OverlayState } from '../src/brawl/draw';
import { CHANNELS } from './channels';

export interface TestModeState {
  on: boolean;
  frame: string;
  frames: string[];
  message: string | null;
}

export interface CaptureState {
  wanted: boolean; // capture the game window now
  probe: boolean; // main.ts is probing for the draft screen (a real game); false: capture simply follows the window
}

const api = {
  isElectron: true as const,
  isE2E: process.env.BRAWL_E2E === '1',
  // e2e only: shortens the ability tip so a full harness run fits its time budget (the real default is 15 s).
  tipMs: process.env.BRAWL_E2E === '1' ? Number(process.env.BRAWL_TIP_MS) || 0 : 0,
  getGameRect: (): Promise<Rect | null> => ipcRenderer.invoke(CHANNELS.getGameRect),
  onGameRect: (cb: (rect: Rect | null) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, rect: Rect | null) => cb(rect);
    ipcRenderer.on(CHANNELS.gameRect, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.gameRect, listener);
    };
  },
  sendOverlayState: (state: OverlayState) => ipcRenderer.send(CHANNELS.overlayState, state),
  onOverlayState: (cb: (state: OverlayState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: OverlayState) => cb(state);
    ipcRenderer.on(CHANNELS.overlayState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.overlayState, listener);
    };
  },
  onCaptureDenied: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.captureDenied, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.captureDenied, listener);
    };
  },
  getCaptureState: (): Promise<CaptureState> => ipcRenderer.invoke(CHANNELS.captureStateGet),
  onCaptureState: (cb: (state: CaptureState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: CaptureState) => cb(state);
    ipcRenderer.on(CHANNELS.captureState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.captureState, listener);
    };
  },
  detectNow: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.detectNow),
  onDetectRun: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.detectRun, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.detectRun, listener);
    };
  },
  detectMiss: () => ipcRenderer.send(CHANNELS.detectMiss),
  captureResult: (ok: boolean) => ipcRenderer.send(CHANNELS.captureResult, ok),
  getDetectKeyInUse: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.detectKeyGet),
  onDetectKeyState: (cb: (inUse: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, inUse: boolean) => cb(inUse);
    ipcRenderer.on(CHANNELS.detectKeyState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.detectKeyState, listener);
    };
  },
  /** The draft (and its ability tip) is over: capture stopped, go back to probing. */
  captureIdle: () => ipcRenderer.send(CHANNELS.captureIdle),
  minimizeWindow: () => ipcRenderer.send(CHANNELS.windowMinimize),
  closeWindow: () => ipcRenderer.send(CHANNELS.windowClose),
  getPlatformWarning: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.platformWarning),
  getTestMode: (): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeGet),
  setTestMode: (on: boolean): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeSet, on),
  setTestFrame: (frame: string): Promise<TestModeState> => ipcRenderer.invoke(CHANNELS.testModeFrame, frame),
  onDebugToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(CHANNELS.debugToggle, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.debugToggle, listener);
    };
  },
  onTestMode: (cb: (state: TestModeState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: TestModeState) => cb(state);
    ipcRenderer.on(CHANNELS.testModeState, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.testModeState, listener);
    };
  },
};

export type BrawlApi = typeof api;
contextBridge.exposeInMainWorld('brawlAPI', api);
