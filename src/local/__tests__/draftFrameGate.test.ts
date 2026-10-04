import { describe, expect, it } from 'vitest';
import type { FrameResult } from '../../brawl/worker';
import { DraftFrameGate } from '../draftFrameGate';

const complete = {
  type: 'result',
  shop: true,
  key: '1,2,3',
  round: 1,
  choice: 3,
  accepted: true,
  reads: [1, 2, 3].map((itemId) => ({ itemId, present: true })),
  meta: null,
  inventory: null,
  ms: 0,
} as FrameResult;
const incomplete = {
  ...complete,
  accepted: false,
  key: '',
  reads: complete.reads.map((r, i) => ({ ...r, present: i < 2 })),
};

describe('draft presentation stability', () => {
  it('does not publish alternating pending OCR and complete reads of the same frame', () => {
    const gate = new DraftFrameGate();
    expect(gate.publish(complete, 0)).toBe(true);
    for (let time = 100; time < 1000; time += 100) {
      expect(gate.publish({ ...incomplete, pending: true }, time)).toBe(false);
      expect(gate.publish(complete, time + 15)).toBe(true);
    }
  });
  it('keeps accepted items throughout a long tooltip, including false partial matches', () => {
    const gate = new DraftFrameGate();
    gate.publish(complete, 0);
    expect(gate.publish(incomplete, 100)).toBe(false);
    expect(gate.publish(incomplete, 600)).toBe(false);
    expect(gate.publish(incomplete, 10_000)).toBe(false);
    expect(gate.publish({ ...incomplete, reads: [{ ...complete.reads[0]!, itemId: 99 }] }, 15_000)).toBe(false);
    expect(gate.publish({ ...complete, key: '99,2,3', accepted: false }, 15_100)).toBe(false);
    expect(gate.publish({ ...complete, accepted: false }, 15_200)).toBe(true);
  });
  it('never retains old advice after a known new choice, round or confirmed reroll', () => {
    const frames = [
      { ...incomplete, choice: 1, pending: true },
      { ...incomplete, round: 2 },
      { ...complete, key: '4,5,6' },
    ];
    for (const frame of frames) {
      const gate = new DraftFrameGate();
      gate.publish(complete, 0);
      expect(gate.publish(frame, 100)).toBe(true);
    }
  });
  it('unlocks after spending a reroll or a persistent end of the draft', () => {
    const gate = new DraftFrameGate();
    gate.publish(complete, 0);
    gate.invalidate();
    expect(gate.publish(incomplete, 100)).toBe(true);
    gate.publish(complete, 200);
    const ended = { ...incomplete, shop: false, reads: [], round: 0, choice: 0 };
    expect(gate.publish(ended, 300)).toBe(false);
    expect(gate.publish(ended, 600)).toBe(true);
  });
  it('ignores an intermediate OCR result before any complete draft is found', () => {
    expect(new DraftFrameGate().publish({ ...incomplete, pending: true }, 0)).toBe(false);
  });
});
