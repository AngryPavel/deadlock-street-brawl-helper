import { describe, expect, it, vi } from 'vitest';
import { drawReads, itemCircle, type OverlayTheme } from '../draw';
import type { CardRead } from '../recognise';
import { cardSlotSelection } from '../../local/cardSlotSelection';

const read = (itemId: number, x: number): CardRead => ({
  card: 'x',
  match: { itemId, x, y: 100, edge: 50, score: 1, margin: 0.5 },
  present: true,
  itemId,
  tier: 1,
  rare: false,
  enhanced: false,
});

const THEME: OverlayTheme = {
  panel: '#101314',
  teal: '#2ec4b6',
  tealInk: '#06201d',
  text: '#ece6da',
  muted: '#a39e92',
  take: '#52e38b',
  takeInk: '#092416',
  reroll: '#f3c969',
};

function stubCtx() {
  const ctx = {
    rect: vi.fn(),
    roundRect: vi.fn(),
    ellipse: vi.fn(),
    beginPath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: t.length * 10 })),
    lineWidth: 0,
    strokeStyle: '' as string,
    fillStyle: '' as string,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    strokes: [] as { color: string; width: number }[],
    fills: [] as string[],
    texts: [] as { text: string; color: string }[],
  };
  ctx.stroke.mockImplementation(() => ctx.strokes.push({ color: ctx.strokeStyle, width: ctx.lineWidth }));
  ctx.fill.mockImplementation(() => ctx.fills.push(ctx.fillStyle));
  ctx.fillText.mockImplementation((text: string) => ctx.texts.push({ text, color: ctx.fillStyle }));
  return ctx as typeof ctx & CanvasRenderingContext2D;
}

const SCORES = { 1: 3.14159, 2: 2.5 };
const GRADES = { 1: 'S', 2: 'B' };
const run = (ctx: CanvasRenderingContext2D, reroll = false, sx = 1, sy = 1) =>
  drawReads(ctx, [read(1, 10), read(2, 200)], 1, sx, sy, 2560, 1440, reroll, SCORES, null, GRADES, THEME);

describe('drawReads', () => {
  it('draws at most one TAKE for duplicated IDs with legacy item-ID-only callers', () => {
    const ctx = stubCtx();
    const drawn = drawReads(ctx, [read(1, 10), read(1, 200)], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(drawn.map((rect) => rect.kind)).toEqual(['best', 'card']);
    expect(drawn.map((rect) => rect.readIndex)).toEqual([0, 1]);
    expect(ctx.ellipse).toHaveBeenCalledTimes(1);
    expect(ctx.texts.filter((text) => text.text === 'TAKE')).toHaveLength(1);
  });

  it('draws each duplicate variant score and tier on its own plate and recommends only the stronger enhanced slot', () => {
    const ctx = stubCtx();
    const reads = [
      { ...read(1, 10), card: 'left' },
      { ...read(1, 200), card: 'right', enhanced: true },
    ];
    const card = { itemId: 1, name: 'Item', enhanced: false, score: 2, grade: 'B', usage: 0, winRate: null, rows: [] };
    const advice = {
      hero: 'Graves',
      round: 4,
      choice: 3,
      reroll: null,
      status: 'Ready',
      ranked: [{ ...card, enhanced: true, score: 5, grade: 'S' }, card],
    };
    const slots = cardSlotSelection(reads, 1, advice);
    const drawn = drawReads(ctx, reads, 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME, slots);
    expect(drawn.map((rect) => [rect.kind, rect.score])).toEqual([
      ['card', 2],
      ['best', 5],
    ]);
    expect(ctx.texts.map((text) => text.text)).toEqual(['B', 'Score: 2.00', 'S', 'Score: 5.00', 'TAKE']);
    expect(ctx.ellipse).toHaveBeenCalledTimes(1);
    const rerolled = drawReads(ctx, reads, 1, 1, 1, 2560, 1440, true, SCORES, null, GRADES, THEME, slots);
    expect(rerolled.filter((rect) => rect.kind === 'best')).toHaveLength(0);
    expect(rerolled.filter((rect) => rect.kind === 'reroll')).toHaveLength(1);
  });

  it('outlines only the best card, as a circle', () => {
    const ctx = stubCtx();
    run(ctx);
    expect(ctx.ellipse).toHaveBeenCalledTimes(1);
  });

  it('puts a plate above each card, centred on it, with the tier letter and "Score: <n>"', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(ctx.texts.map((t) => t.text)).toEqual(['S', 'Score: 3.14', 'TAKE', 'B', 'Score: 2.50']);
    const { cx, cy, r } = itemCircle({ x: 10, y: 100, edge: 50 });
    const plate = drawn[0].plate!;
    expect((plate.x0 + plate.x1) / 2).toBeCloseTo(cx, 0);
    expect(plate.y1).toBeLessThanOrEqual(cy - r);
    expect(drawn.map((d) => d.score)).toEqual([3.14159, 2.5]);
  });

  it('fills the best plate green with TAKE and dark text; other cards keep a quiet border and their scores', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(drawn.map((d) => d.kind)).toEqual(['best', 'card']);
    expect(ctx.strokes[0]).toEqual({ color: THEME.take, width: 3 }); // card outline
    expect(ctx.strokes.slice(1)).toEqual([{ color: THEME.teal, width: 1 }]); // the other plate's border only
    expect(ctx.fills[0]).toBe(THEME.take);
    expect(ctx.texts[1].color).toBe(THEME.takeInk);
    expect(ctx.texts[2]).toEqual({ text: 'TAKE', color: THEME.takeInk });
    expect(ctx.texts[4].color).toBe(THEME.muted);
  });

  it('keeps the score text at least 14 px tall', () => {
    const ctx = stubCtx();
    ctx.font = '';
    drawReads(ctx, [read(1, 10)], 1, 0.1, 0.1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(ctx.font).toMatch(/^bold (\d+)px/);
    expect(Number(/(\d+)px/.exec(ctx.font)![1])).toBeGreaterThanOrEqual(14);
  });

  it('gives no card the best style and boxes the re-roll button when reroll is true', () => {
    const ctx = stubCtx();
    const drawn = run(ctx, true);
    expect(drawn.filter((d) => d.kind === 'best')).toHaveLength(0);
    expect(ctx.strokes.filter((s) => s.width === 3)).toHaveLength(1); // the re-roll box only
    expect(ctx.texts.filter((t) => t.text === 'RE-ROLL')).toHaveLength(1);
    expect(ctx.texts.filter((t) => t.text === 'TAKE')).toHaveLength(0);
    expect(ctx.strokes.find((s) => s.width === 3)?.color).toBe(THEME.reroll);
    const rr = drawn.find((d) => d.kind === 'reroll')!;
    expect(rr.plate).toBeNull();
  });

  it('scales plates with the canvas', () => {
    const a = run(stubCtx(), false, 1, 1);
    const b = run(stubCtx(), false, 2, 2);
    const wa = a[0].plate!.x1 - a[0].plate!.x0;
    const wb = b[0].plate!.x1 - b[0].plate!.x0;
    expect(wb / wa).toBeCloseTo(1, 0); // frame px stay put; canvas px double
  });
});
