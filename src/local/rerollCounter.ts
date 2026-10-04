import type { RGBImage } from '../brawl/recognise';
import { extractRerollLabelCrop } from '../brawl/recognise';
import { readRerollsRemaining } from '../brawl/ocr';
import { sameRerollContext, type RerollContext } from './rerollAvailability';

const readVisibleCounter = (img: RGBImage) =>
  extractRerollLabelCrop(img) ? readRerollsRemaining(img) : Promise.resolve(-1);

/** Cheap normalized label fingerprint: OCR is needed only for a new/changed label or initial confirmation. */
export function rerollLabelSignature(img: RGBImage): string | null {
  const crop = extractRerollLabelCrop(img);
  if (!crop) return null;
  let signature = '';
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const px = Math.min(crop.width - 1, Math.floor(((x + 0.5) * crop.width) / 16));
      const py = Math.min(crop.height - 1, Math.floor(((y + 0.5) * crop.height) / 16));
      signature += crop.data[(py * crop.width + px) * 4]! < 128 ? '1' : '0';
    }
  return signature;
}

/** The count belongs to the round. A tooltip cannot erase it; a new round must reread it. */
export class RerollCounterReader {
  private epoch = 0;
  private context: RerollContext | null = null;
  private busy = false;
  private nextAt = 0;
  private candidate = -1;
  private candidateReads = 0;
  private candidateSignature: string | null = null;
  private confirmedCount: number | null = null;
  private ceiling: number | null = null;
  private confirmedSignature: string | null = null;
  private read: typeof readRerollsRemaining;
  private fingerprint: typeof rerollLabelSignature;
  constructor(read = readVisibleCounter, fingerprint = rerollLabelSignature) {
    this.read = read;
    this.fingerprint = fingerprint;
  }
  get value() {
    return this.confirmedCount;
  }
  reset() {
    this.epoch++;
    this.context = null;
    this.nextAt = 0;
    this.candidate = -1;
    this.candidateReads = 0;
    this.candidateSignature = null;
    this.confirmedCount = this.ceiling = null;
    this.confirmedSignature = null;
    this.busy = false;
  }
  poll(
    img: RGBImage,
    context: RerollContext,
    now: number,
    emit: (value: number, context: RerollContext, spent: boolean) => void,
  ) {
    if (context.round === 0 && this.context) {
      const wrapped = context.choice === 1 && this.context.choice > 1;
      context = { ...context, round: wrapped ? Math.min(5, this.context.round + 1) : this.context.round };
    }
    if (!this.context || !sameRerollContext(this.context, context)) {
      const previous = this.context;
      const newRound = !previous || (context.round > 0 && context.round !== previous.round);
      if (newRound) this.reset();
      else {
        this.epoch++;
        this.busy = false;
        this.candidate = -1;
        this.candidateReads = 0;
        this.nextAt = 0;
      }
      this.context = { ...context };
      emit(this.confirmedCount ?? -1, context, false);
    }
    if (this.busy || now < this.nextAt) return;
    const signature = this.fingerprint(img);
    if (signature === null) return; // Covered label is missing evidence, not a zero and not a reset.
    const confirming = this.candidateReads === 1;
    if (this.confirmedCount !== null && signature === this.confirmedSignature && !confirming) return;
    const epoch = this.epoch;
    this.busy = true;
    // The reader copies label pixels synchronously before awaiting OCR.
    void this.read(img)
      .catch(() => -1)
      .then((value) => {
        if (epoch !== this.epoch) return;
        this.nextAt = performance.now() + 400;
        if (!Number.isInteger(value) || value < 0 || value > 10) {
          this.candidate = -1;
          this.candidateReads = 0;
          this.candidateSignature = null;
          return; // Retain the last confirmed count through an unreadable tooltip.
        }
        if (this.ceiling !== null && value > this.ceiling) {
          this.candidate = -1;
          this.candidateReads = 0;
          this.candidateSignature = null;
          return;
        } // Counts cannot grow within this round.
        this.candidateReads =
          this.candidate === value && this.candidateSignature === signature ? this.candidateReads + 1 : 1;
        this.candidate = value;
        this.candidateSignature = signature;
        if (this.candidateReads < 2) return;
        const spent = this.confirmedCount !== null && value < this.confirmedCount;
        this.confirmedCount = this.ceiling = value;
        this.confirmedSignature = signature;
        this.candidateReads = 0;
        emit(value, context, spent);
      })
      .finally(() => {
        if (epoch === this.epoch) this.busy = false;
      });
  }
}
