import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import { extractRerollLabelCrop, rerollGlyphIsOne, type RGBImage } from './recognise';

// All assets (worker script, wasm core, eng.traineddata.gz) are bundled under public/ocr/ so this reads
// real digits via OCR without any network access at runtime -- required for an offline desktop app, and
// the same bundle serves both the browser/worker build and the Node fixtures/CLI build below.
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

// The label crop is only ~47x37px at reference resolution: Tesseract needs real size to read it (a tiny,
// unscaled crop reads as empty text with 0 confidence -- verified against screenshots/brawl/reroll-choice*.png).
const UPSCALE = 8;

let workerPromise: Promise<TesseractWorker> | null = null;

async function nodeOcrDir(): Promise<string> {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'ocr');
}

/** Absolute URLs into public/ocr. A root-relative '/ocr/...' is invalid under file:// (packaged app), where it
 *  resolves to file:///ocr/; the built worker lives in dist/assets/, so the bundle is at ../ocr there. */
function browserOcrOpts() {
  const dir = import.meta.env.DEV
    ? new URL('/ocr/', self.location.href).href
    : new URL('../ocr/', self.location.href).href;
  const base = dir.replace(/\/$/, '');
  return { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true };
}

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const opts = isNode ? { langPath: await nodeOcrDir(), gzip: true } : browserOcrOpts();
      const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, opts);
      // The crop always shows just "N Re-Roll..."; a digit whitelist means the rest of the caption's
      // letters are simply not in Tesseract's output alphabet, so they don't need to be cropped out.
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE });
      return worker;
    })();
  }
  return workerPromise;
}

/** Upscales the raw RGBA crop with smooth (Lanczos-equivalent) resampling and encodes it as PNG for
 *  Tesseract -- plain nearest-neighbor/binarized upscaling reads as empty text; smooth resampling is what
 *  actually let Tesseract read the real "1" in screenshots/brawl/reroll-choice*.png. */
async function upscaledPng(data: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const outW = width * UPSCALE,
    outH = height * UPSCALE;
  if (typeof OffscreenCanvas !== 'undefined') {
    const src = new OffscreenCanvas(width, height);
    const sctx = src.getContext('2d');
    if (!sctx) throw new Error('OffscreenCanvas 2d context unavailable');
    sctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const big = new OffscreenCanvas(outW, outH);
    const bctx = big.getContext('2d');
    if (!bctx) throw new Error('OffscreenCanvas 2d context unavailable');
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(src, 0, 0, outW, outH);
    const blob = await big.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .resize({ width: outW, height: outH, kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/** Real OCR read of the "N Re-Roll Remaining" caption's digit -- not a stored pixel-shape template, an
 *  actual text recognition pass over the on-screen label. Returns 0 when the caption shows no glyph at all
 *  (no re-rolls left, or the caption is hidden), the parsed digit when OCR reads exactly one, or -1 when
 *  OCR can't confidently produce a single digit (so a bad read never gets silently reported as 0). */
/** Starts loading the OCR engine now, so the first real read does not stall the frames that follow it. */
export function warmOCR(): void {
  void getWorker().catch(() => {
    workerPromise = null;
  });
}

export async function readRerollsRemaining(img: RGBImage): Promise<number> {
  const crop = extractRerollLabelCrop(img);
  if (!crop) return 0;
  const png = await upscaledPng(crop.data, crop.width, crop.height);
  const worker = await getWorker();
  // tesseract.js's types only accept Buffer here, but both its Node and browser loadImage() ultimately just
  // do `new Uint8Array(data)` on whatever's passed -- a plain Uint8Array works identically at runtime.
  const {
    data: { text },
  } = await worker.recognize(png as unknown as Buffer);
  // Street Brawl gives 0 or 1 re-roll (brawl-config: 1 per round), so only 0/1 are believable reads. Anything
  // else (a "0" read as a letter, a "1" read as 7) falls back to the glyph's shape: a thin upright bar is a 1,
  // any other glyph is a 0. Returning -1 here left the previous count standing, so a spent re-roll never showed.
  const digits = text.trim().match(/^[01]$/);
  if (digits) return Number(digits[0]);
  return rerollGlyphIsOne(img) ? 1 : 0;
}

/** Releases the OCR worker (and its wasm/model memory). Call on app/window teardown; a new call to
 *  readRerollsRemaining after this spins up a fresh worker on demand. */
export async function terminateOCR(): Promise<void> {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    await (await pending).terminate();
  } catch {
    /* it never finished loading, or is already gone */
  }
}
