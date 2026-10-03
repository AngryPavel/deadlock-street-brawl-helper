export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_WIDTH = 360;
export const MIN_HEIGHT = 300;
const DEFAULT_SIZE = { width: 460, height: 640 };

export function isBounds(v: unknown): v is Bounds {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k] as number));
}

/** Bounds to open the control window with: the saved ones when their title strip is on a connected display (at
 *  least 80x32 px of it), clamped to the minimum size; otherwise the default size centred on `primary`. */
export function validBounds(saved: unknown, displays: Bounds[], primary: Bounds): Bounds {
  if (isBounds(saved) && saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT) {
    const strip = { x: saved.x, y: saved.y, width: saved.width, height: 32 };
    const onScreen = displays.some((d) => {
      const w = Math.min(strip.x + strip.width, d.x + d.width) - Math.max(strip.x, d.x);
      const h = Math.min(strip.y + strip.height, d.y + d.height) - Math.max(strip.y, d.y);
      return w >= 80 && h >= 32;
    });
    if (onScreen) return saved;
  }
  const width = Math.min(DEFAULT_SIZE.width, primary.width);
  const height = Math.min(DEFAULT_SIZE.height, primary.height);
  return {
    width,
    height,
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
  };
}
