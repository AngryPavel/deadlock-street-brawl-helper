import { describe, expect, it } from 'vitest';
import { BLANK_OVERLAY, type DrawnRect, type OverlayState } from '../../brawl/draw';
import { overlayActionCueLayout, overlayDraftAction } from '../overlayCueGeometry';

const state: OverlayState = {
  ...BLANK_OVERLAY,
  draft: true,
  bestId: 7,
  frameW: 3440,
  frameH: 1440,
  reads: [
    {
      present: true,
      itemId: 7,
      card: 'left',
      tier: 1,
      rare: false,
      enhanced: false,
      match: { itemId: 7, x: 300, y: 500, edge: 130, score: 1, margin: 0.5 },
    },
  ],
  advice: {
    hero: 'Infernus',
    round: 2,
    choice: 1,
    reroll: { currentBest: 1, expectedBest: 2 },
    rerollsRemaining: 1,
    ranked: [{ itemId: 7, name: 'Item', score: 1, enhanced: false, usage: 0, winRate: null, grade: 'B', rows: [] }],
    status: 'Ready',
  },
};
const best: DrawnRect = {
  kind: 'best',
  itemId: 7,
  card: 'left',
  x0: 200,
  y0: 400,
  x1: 600,
  y1: 800,
  score: 1,
  plate: { x0: 250, y0: 350, x1: 550, y1: 390 },
};
const reroll: DrawnRect = { ...best, kind: 'reroll', itemId: null, card: null, score: null, plate: null };

describe('overlay actions', () => {
  it('takes the best item or rerolls, never both', () => {
    expect(overlayDraftAction(state)).toEqual({ bestId: 7, reroll: false });
    expect(overlayDraftAction({ ...state, reroll: true })).toEqual({ bestId: null, reroll: true });
  });

  it('rejects spending unknown, exhausted, invalid counts even if the incoming reroll flag says yes', () => {
    for (const count of [0, -1, null, undefined, NaN, Infinity, 1.5]) {
      expect(
        overlayDraftAction({
          ...state,
          reroll: true,
          bestId: null,
          advice: { ...state.advice!, rerollsRemaining: count },
        }),
      ).toEqual({ bestId: 7, reroll: false });
    }
  });

  it('never points to a missing item or promotes a take without a recommendation', () => {
    expect(overlayDraftAction({ ...state, reads: [] })).toEqual({ bestId: null, reroll: false });
    expect(overlayDraftAction({ ...state, bestId: null })).toEqual({ bestId: null, reroll: false });
    expect(overlayDraftAction({ ...state, draft: false, reroll: true })).toEqual({ bestId: null, reroll: false });
  });
});

describe('overlay cue alignment', () => {
  it('follows the actual best plate in CSS pixels at 125% display scaling on an ultrawide capture', () => {
    expect(overlayActionCueLayout([best], 3440, 1440, 2752, 1152)).toEqual({
      action: 'take',
      itemId: 7,
      left: 200,
      top: 280,
      width: 240,
      height: 32,
    });
  });

  it('scales each axis and points the reroll glow to the button, without covering its label', () => {
    expect(overlayActionCueLayout([best, reroll], 3440, 1440, 1720, 1080)).toEqual({
      action: 'reroll',
      itemId: null,
      left: 100,
      top: 300,
      width: 200,
      height: 300,
    });
  });

  it('clears outside the draft and rejects missing plates or invalid frame/rectangle dimensions', () => {
    expect(overlayActionCueLayout([], 3440, 1440, 2752, 1152)).toBeNull();
    expect(overlayActionCueLayout([{ ...best, plate: null }], 3440, 1440, 2752, 1152)).toBeNull();
    expect(overlayActionCueLayout([best], 0, 1440, 2752, 1152)).toBeNull();
    expect(overlayActionCueLayout([best], 3440, NaN, 2752, 1152)).toBeNull();
    expect(overlayActionCueLayout([{ ...reroll, x1: reroll.x0 }], 3440, 1440, 2752, 1152)).toBeNull();
  });
});
