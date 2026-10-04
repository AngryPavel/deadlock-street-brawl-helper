/** Street Brawl centres a height-scaled 16:9 HUD on wide screens. Small capture crops keep per-axis scaling. */
export function hudLayout(width: number, height: number) {
  const sy = height / 1440;
  const wide = width / height > (2560 / 1440) * 1.05;
  const sx = wide ? sy : width / 2560;
  const offsetX = wide ? (width - 2560 * sx) / 2 : 0;
  return { sx, sy, offsetX };
}
