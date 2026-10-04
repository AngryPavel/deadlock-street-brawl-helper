import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ create: vi.fn(), encode: vi.fn() }));
vi.mock('tesseract.js', () => ({ createWorker: state.create, PSM: { SINGLE_LINE: 7 } }));
vi.mock('sharp', () => ({
  default: () => ({
    resize() {
      return this;
    },
    png() {
      return this;
    },
    toBuffer: state.encode,
  }),
}));
const crop = { data: new Uint8Array(4), width: 1, height: 1 };
const result = { data: { text: 'Quicksilver Reload', confidence: 95 } };
const engine = () => ({
  setParameters: vi.fn().mockResolvedValue(undefined),
  recognize: vi.fn().mockResolvedValue(result),
  terminate: vi.fn().mockResolvedValue(undefined),
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let ocr: typeof import('../cardNameOcr');
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  state.create.mockReset();
  state.encode.mockReset().mockResolvedValue(Buffer.from([0]));
  ocr = await import('../cardNameOcr');
});
afterEach(async () => {
  await ocr.stopItemNameOCR();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('item OCR lifecycle', () => {
  it('evicts rejected initialization so the next call succeeds without resetting capture', async () => {
    const next = engine();
    state.create.mockRejectedValueOnce(new Error('initialization failed')).mockResolvedValue(next);
    await expect(ocr.readItemName(crop)).rejects.toThrow('initialization failed');
    await expect(ocr.readItemName(crop)).resolves.toEqual({ text: result.data.text, confidence: 95 });
    expect(state.create).toHaveBeenCalledTimes(2);
  });
  it.each(['encode', 'initialize', 'initialize parameters', 'job parameters', 'recognize'])(
    'bounds the whole job when %s never resolves and recovers on the next call',
    async (stage) => {
      const old = engine(),
        next = engine();
      const never = new Promise<never>(() => {});
      if (stage === 'encode') state.encode.mockReturnValueOnce(never);
      if (stage === 'initialize parameters') old.setParameters.mockReturnValueOnce(never);
      if (stage === 'job parameters') old.setParameters.mockResolvedValueOnce(undefined).mockReturnValueOnce(never);
      if (stage === 'recognize') old.recognize.mockReturnValueOnce(never);
      if (stage === 'initialize') state.create.mockReturnValueOnce(never).mockResolvedValue(next);
      else state.create.mockResolvedValueOnce(old).mockResolvedValue(next);
      const failed = ocr.readItemName(crop).catch((error) => error);
      await vi.advanceTimersByTimeAsync(ocr.ITEM_NAME_OCR_TIMEOUT_MS);
      expect(await failed).toMatchObject({ message: 'Item OCR timed out' });
      if (stage === 'encode') state.create.mockReset().mockResolvedValue(next);
      await expect(ocr.readItemName(crop)).resolves.toEqual({ text: result.data.text, confidence: 95 });
      expect(next.terminate).not.toHaveBeenCalled();
    },
  );
  it('detaches a hung queue on Stop; late recognition and hung terminate cannot affect a new engine', async () => {
    const old = engine(),
      next = engine();
    const recognition = deferred<typeof result>();
    old.recognize.mockReturnValue(recognition.promise);
    old.terminate.mockReturnValue(new Promise(() => {}));
    state.create.mockResolvedValueOnce(old).mockResolvedValue(next);
    const first = ocr.readItemName(crop).catch((error) => error);
    const queued = ocr.readItemName(crop).catch((error) => error);
    await vi.waitFor(() => expect(old.recognize).toHaveBeenCalledOnce());
    await ocr.stopItemNameOCR();
    expect(await first).toMatchObject({ message: 'Item OCR stopped' });
    expect(await queued).toMatchObject({ message: 'Item OCR stopped' });
    await expect(ocr.readItemName(crop)).resolves.toMatchObject({ confidence: 95 });
    recognition.resolve({ data: { text: 'STALE', confidence: 100 } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(ocr.readItemName(crop, true)).resolves.toMatchObject({ confidence: 95 });
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(next.terminate).not.toHaveBeenCalled();
    expect(next.setParameters).toHaveBeenLastCalledWith({
      tessedit_pageseg_mode: 7,
      tessedit_char_whitelist: '0123456789',
    });
  });
  it.each(['resolve', 'reject'])(
    'discards a stale initialization that later %ss without evicting the new engine',
    async (mode) => {
      const initialization = deferred<ReturnType<typeof engine>>();
      const old = engine(),
        next = engine();
      state.create.mockReturnValueOnce(initialization.promise).mockResolvedValue(next);
      const failed = ocr.readItemName(crop).catch((error) => error);
      await vi.waitFor(() => expect(state.create).toHaveBeenCalledOnce());
      await ocr.stopItemNameOCR();
      expect(await failed).toMatchObject({ message: 'Item OCR stopped' });
      await expect(ocr.readItemName(crop)).resolves.toMatchObject({ confidence: 95 });
      if (mode === 'resolve') initialization.resolve(old);
      else initialization.reject(new Error('old initialization failed'));
      await vi.advanceTimersByTimeAsync(0);
      await expect(ocr.readItemName(crop)).resolves.toMatchObject({ confidence: 95 });
      expect(state.create).toHaveBeenCalledTimes(2);
      if (mode === 'resolve') expect(old.terminate).toHaveBeenCalledOnce();
      expect(next.terminate).not.toHaveBeenCalled();
    },
  );
  it('bounds queue waiting and does not let stale completions reset the new queue', async () => {
    const old = engine(),
      next = engine();
    const stale = deferred<typeof result>(),
      fresh = deferred<typeof result>();
    old.recognize.mockReturnValue(stale.promise);
    next.recognize.mockReturnValueOnce(fresh.promise).mockResolvedValue(result);
    state.create.mockResolvedValueOnce(old).mockResolvedValue(next);
    const first = ocr.readItemName(crop).catch((error) => error),
      waiting = ocr.readItemName(crop).catch((error) => error);
    await vi.advanceTimersByTimeAsync(ocr.ITEM_NAME_OCR_TIMEOUT_MS);
    expect(await first).toBeInstanceOf(Error);
    expect(await waiting).toBeInstanceOf(Error);
    const newFirst = ocr.readItemName(crop),
      newSecond = ocr.readItemName(crop);
    await vi.waitFor(() => expect(next.recognize).toHaveBeenCalledOnce());
    stale.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(next.recognize).toHaveBeenCalledOnce(); // the new queue still waits for its own first job
    fresh.resolve(result);
    await expect(newFirst).resolves.toMatchObject({ confidence: 95 });
    await expect(newSecond).resolves.toMatchObject({ confidence: 95 });
    expect(next.recognize).toHaveBeenCalledTimes(2);
    expect(next.terminate).not.toHaveBeenCalled();
  });
});
