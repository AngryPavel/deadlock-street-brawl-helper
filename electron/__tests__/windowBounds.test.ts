import { describe, expect, it } from 'vitest';
import { validBounds } from '../windowBounds';

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const second = { x: 1920, y: 0, width: 1920, height: 1080 };

describe('validBounds', () => {
  it('keeps saved bounds that are on a connected display', () => {
    const saved = { x: 100, y: 50, width: 500, height: 700 };
    expect(validBounds(saved, [primary], primary)).toEqual(saved);
  });
  it('opens centred on the primary display when the saved spot is off every display', () => {
    const saved = { x: 2500, y: 100, width: 500, height: 700 };
    expect(validBounds(saved, [primary], primary)).toEqual({ x: 730, y: 220, width: 460, height: 640 });
    expect(validBounds(saved, [primary, second], primary)).toEqual(saved);
  });
  it('rejects junk and too-small sizes', () => {
    expect(validBounds('x', [primary], primary).width).toBe(460);
    expect(validBounds({ x: 0, y: 0, width: 100, height: 100 }, [primary], primary).width).toBe(460);
  });
});
