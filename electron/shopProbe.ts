// The cheap draft/preparation check main.ts runs instead of capturing the game window: read only the
// CHOICE glyph or the first ROUND glyph plus fixed countdown caption inside the game's bounds.
// Pure apart from the injected `grab`, so it is testable without Windows.
import { isShopScreen, readRoundChoice, roundProbeRect, shopProbeRect, type RGBImage } from '../src/brawl/recognise';
import { hasRoundCountdown, roundCountdownRegion } from '../src/local/firstRoundPreparation';
import type { Rect } from './gameWindow';

/** Reads a screen rectangle (physical px) as BGRA bytes, or null if it cannot. */
export type GrabRegion = (x: number, y: number, width: number, height: number) => Uint8Array | null;

export function probeShopScreen(game: Rect, grab: GrabRegion): boolean {
  const choice = grabCrop(game, grab, shopProbeRect(game.width, game.height));
  if (!choice) return false;
  if (isShopScreen(choice)) return true;
  // Capture can begin after the last item pick or resume after a long cue dropout. Both the actual
  // ROUND 1 glyph and complete fixed countdown caption are required; seconds alone never trigger it.
  const round = grabCrop(game, grab, roundProbeRect(game.width, game.height));
  if (!round || readRoundChoice(round).round !== 1) return false;
  const caption = grabCrop(game, grab, roundCountdownRegion(game.width, game.height));
  return !!caption && hasRoundCountdown(caption);
}

function grabCrop(
  game: Rect,
  grab: GrabRegion,
  r: { x: number; y: number; width: number; height: number },
): RGBImage | null {
  if (r.width <= 0 || r.height <= 0) return null;
  const bgra = grab(game.x + r.x, game.y + r.y, r.width, r.height);
  if (!bgra || bgra.length < r.width * r.height * 4) return null;
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgra[i + 2]!;
    data[i + 1] = bgra[i + 1]!;
    data[i + 2] = bgra[i]!;
    data[i + 3] = 255;
  }
  return {
    width: r.width,
    height: r.height,
    data,
    channels: 4,
    origin: { x: r.x, y: r.y, fullWidth: game.width, fullHeight: game.height },
  };
}
