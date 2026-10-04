/** Shared renderer/main-process contract. Updates never execute renderer-supplied commands or paths. */
export interface PatchAnnouncement {
  title: string;
  timestamp: number;
  url: string;
}
export interface DataStatus {
  baseUrl: string;
  fetchedAt: string | null;
  sincePatch: string | null;
  latestPatch: PatchAnnouncement | null;
  patchCheckError: string | null;
  canIncrement: boolean;
}
export interface UpdateRequest {
  mode: 'full' | 'incremental';
  since: string;
}
export interface UpdateProgress {
  phase: 'idle' | 'running' | 'complete' | 'cancelled' | 'error';
  stage: string;
  completed: number;
  total: number;
  percent: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  message: string;
  warnings: string[];
}
