import { createWorker, PSM, type Worker } from 'tesseract.js';

/** Includes queue wait, image encoding, cold initialization, parameter updates and recognition. */
export const ITEM_NAME_OCR_TIMEOUT_MS = 10_000;
export interface ItemNameOcrCrop {
  data: Uint8Array;
  width: number;
  height: number;
  scale?: number;
  interpolation?: 'nearest';
}
interface Engine {
  generation: number;
  ready: Promise<Worker>;
  instance: Worker | null;
  disposed: boolean;
  terminating: boolean;
}
let current: Engine | null = null;
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
let cancellation = new AbortController();
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
const stopped = () => new Error('Item OCR stopped');
const assertGeneration = (session: number) => {
  if (session !== generation) throw stopped();
};

/** Cleanup owns one engine, never whatever engine a later capture happens to be using. */
function dispose(engine: Engine) {
  engine.disposed = true;
  if (!engine.instance || engine.terminating) return;
  engine.terminating = true;
  try {
    void engine.instance.terminate().catch(() => {});
  } catch {
    /* best effort, never block a new queue */
  }
}
function invalidate() {
  const old = current;
  current = null;
  generation++;
  const oldCancellation = cancellation;
  cancellation = new AbortController();
  queue = Promise.resolve();
  oldCancellation.abort();
  if (old) dispose(old);
}

async function engineFor(session: number): Promise<Engine> {
  assertGeneration(session);
  if (!current) {
    const engine: Engine = {
      generation: session,
      ready: null as unknown as Promise<Worker>,
      instance: null,
      disposed: false,
      terminating: false,
    };
    current = engine;
    engine.ready = (async () => {
      let options;
      if (isNode) {
        const { fileURLToPath } = await import('node:url');
        assertGeneration(session);
        options = { langPath: fileURLToPath(new URL('../../public/ocr/', import.meta.url)), gzip: true };
      } else {
        const base = (
          import.meta.env.DEV
            ? new URL('/ocr/', self.location.href)
            : new URL(typeof window === 'undefined' ? '../ocr/' : './ocr/', self.location.href)
        ).href.replace(/\/$/, '');
        options = { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true };
      }
      assertGeneration(session);
      const instance = await createWorker('eng', 1, options);
      engine.instance = instance;
      if (engine.disposed || engine.generation !== generation) {
        dispose(engine);
        throw stopped();
      }
      await instance.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-&",
      });
      if (engine.disposed || engine.generation !== generation) {
        dispose(engine);
        throw stopped();
      }
      return instance;
    })().catch((error) => {
      // A failed initialization must be retryable without F8. A stale rejection cannot evict a newer engine.
      if (current === engine) current = null;
      dispose(engine);
      throw error;
    });
  }
  const engine = current;
  await engine.ready;
  assertGeneration(session);
  return engine;
}

async function encode(crop: ItemNameOcrCrop) {
  const scale = crop.scale ?? 3;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(crop.width, crop.height);
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(crop.data), crop.width, crop.height), 0, 0);
    const big = new OffscreenCanvas(crop.width * scale, crop.height * scale);
    const ctx = big.getContext('2d')!;
    ctx.imageSmoothingEnabled = crop.interpolation !== 'nearest';
    ctx.drawImage(canvas, 0, 0, big.width, big.height);
    return new Uint8Array(await (await big.convertToBlob({ type: 'image/png' })).arrayBuffer());
  }
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(crop.data), { raw: { width: crop.width, height: crop.height, channels: 4 } })
    .resize(crop.width * scale, crop.height * scale, {
      kernel: crop.interpolation === 'nearest' ? 'nearest' : 'lanczos3',
    })
    .png()
    .toBuffer();
}

export function readItemName(crop: ItemNameOcrCrop, digitsOnly = false) {
  const session = generation;
  const signal = cancellation.signal;
  const previous = queue;
  let owner: Engine | null = null;
  const operation = previous
    .catch(() => {})
    .then(async () => {
      assertGeneration(session);
      const png = await encode(crop);
      assertGeneration(session);
      owner = await engineFor(session);
      assertGeneration(session);
      const instance = owner.instance!;
      await instance.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: digitsOnly
          ? '0123456789'
          : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-&",
      });
      assertGeneration(session);
      const result = await instance.recognize(png as unknown as Buffer);
      assertGeneration(session); // late recognition after Stop/timeout must never become usable card evidence
      return { text: result.data.text, confidence: result.data.confidence };
    })
    .catch((error) => {
      if (owner) {
        if (current === owner) current = null;
        dispose(owner);
      }
      throw error;
    });
  let timer: ReturnType<typeof setTimeout>;
  let onStop: () => void;
  const bounded = new Promise<{ text: string; confidence: number }>((resolve, reject) => {
    onStop = () => reject(stopped());
    signal.addEventListener('abort', onStop, { once: true });
    timer = setTimeout(() => {
      reject(new Error('Item OCR timed out'));
      if (session === generation) invalidate();
    }, ITEM_NAME_OCR_TIMEOUT_MS);
    operation.then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onStop);
  });
  queue = bounded.then(
    () => {},
    () => {},
  );
  return bounded;
}

/** Detach immediately; a hung old initialization, recognition or terminate cannot stall a new capture. */
export async function stopItemNameOCR() {
  invalidate();
}
