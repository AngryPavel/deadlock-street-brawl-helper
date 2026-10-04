import { net } from 'electron';

/** Electron's Chromium HTTP stack avoids external Node/Python processes and uses the system proxy. */
export class UpdateHttp {
  private nextAt = 0;
  constructor(
    private signal: AbortSignal,
    private notify: (message: string) => void,
  ) {}
  private async wait(ms: number) {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('Update cancelled.'));
      };
      this.signal.addEventListener('abort', abort, { once: true });
    });
  }
  async bytes(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS data sources are supported.');
    this.signal.throwIfAborted();
    const at = Math.max(Date.now(), this.nextAt);
    this.nextAt = at + 450; // Less than 200 requests/min, shared by all concurrent workers.
    await this.wait(at - Date.now());
    for (let attempt = 1; attempt <= 3; attempt++) {
      const timeout = new AbortController();
      const abort = () => timeout.abort();
      this.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 45_000);
      try {
        const response = await net.fetch(url, {
          signal: timeout.signal,
          headers: { Accept: 'application/json, image/*' },
        });
        if (!response.ok) {
          const retry = response.status === 429 || response.status >= 500;
          const seconds = Number(response.headers.get('retry-after')) || attempt * 2;
          if (!retry || attempt === 3 || seconds > 60)
            throw new Error(`HTTP ${response.status} from ${parsed.hostname}. Try again later.`);
          this.notify(`Server busy (HTTP ${response.status}); retrying in ${seconds}s (${attempt}/3).`);
          await this.wait(seconds * 1000);
          continue;
        }
        const length = Number(response.headers.get('content-length'));
        if (length > 128 * 1024 * 1024) throw new Error('Data response is too large.');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 128 * 1024 * 1024) throw new Error('Data response is too large.');
        return bytes;
      } catch (error) {
        this.signal.throwIfAborted();
        if (attempt === 3 || (error instanceof Error && /HTTP|too large/.test(error.message))) throw error;
        this.notify(`Connection interrupted; retrying (${attempt}/3).`);
        await this.wait(attempt * 2000);
      } finally {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
      }
    }
    throw new Error('Data source did not respond.');
  }
  async json<T>(url: string): Promise<T> {
    return JSON.parse((await this.bytes(url)).toString('utf8')) as T;
  }
}
