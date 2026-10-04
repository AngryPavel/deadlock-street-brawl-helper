import { createWorker, PSM, type Worker } from 'tesseract.js';

let pending: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
async function worker() {
  pending ??= (async () => {
    let options;
    if (isNode) {
      const { fileURLToPath } = await import('node:url');
      options = { langPath: fileURLToPath(new URL('../../public/ocr/', import.meta.url)), gzip: true };
    } else {
      const base = (
        import.meta.env.DEV ? new URL('/ocr/', self.location.href) : new URL('../ocr/', self.location.href)
      ).href.replace(/\/$/, '');
      options = { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, gzip: true };
    }
    const instance = await createWorker('eng', 1, options);
    await instance.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-&",
    });
    return instance;
  })();
  return pending;
}

export function readItemName(crop: { data: Uint8Array; width: number; height: number }) {
  const session = generation;
  const job = queue
    .catch(() => {})
    .then(async () => {
      if (session !== generation) throw new Error('Item OCR stopped');
      let png: Uint8Array;
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(crop.width, crop.height);
        canvas
          .getContext('2d')!
          .putImageData(new ImageData(new Uint8ClampedArray(crop.data), crop.width, crop.height), 0, 0);
        const big = new OffscreenCanvas(crop.width * 3, crop.height * 3);
        const ctx = big.getContext('2d')!;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(canvas, 0, 0, big.width, big.height);
        png = new Uint8Array(await (await big.convertToBlob({ type: 'image/png' })).arrayBuffer());
      } else {
        const sharp = (await import('sharp')).default;
        png = await sharp(Buffer.from(crop.data), { raw: { width: crop.width, height: crop.height, channels: 4 } })
          .resize(crop.width * 3, crop.height * 3)
          .png()
          .toBuffer();
      }
      const instance = await worker();
      if (session !== generation) throw new Error('Item OCR stopped');
      const result = await instance.recognize(png as unknown as Buffer);
      return { text: result.data.text, confidence: result.data.confidence };
    });
  queue = job;
  return job;
}

export async function stopItemNameOCR() {
  generation++;
  const old = pending;
  pending = null;
  if (old)
    try {
      await (await old).terminate();
    } catch {
      /* loading/capture already stopped */
    }
}
