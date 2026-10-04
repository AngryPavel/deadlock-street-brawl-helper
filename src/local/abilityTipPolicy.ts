/** A bank is not enough: all 12 upgrades cost 32, and a remaining bank may not afford any next tier. */
export function canSpendAbilityPoints(allocated: number, bank: number): boolean | null {
  const spent = allocated - bank;
  if (!Number.isInteger(bank) || bank < 0 || spent < 0) return null;
  if (bank === 0 || spent >= 32) return false;
  const paid = [0, 1, 3, 8],
    next = [1, 2, 5, Infinity];
  let compatible = false;
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
      for (let c = 0; c < 4; c++)
        for (let d = 0; d < 4; d++) {
          if (paid[a]! + paid[b]! + paid[c]! + paid[d] !== spent) continue;
          compatible = true;
          if (Math.min(next[a]!, next[b]!, next[c]!, next[d]!) <= bank) return true;
        }
  // Cannot infer the actual purchased ability from a bank alone. Inconsistent/bonus AP uses a bounded fallback.
  return compatible ? false : null;
}
export type AbilityPoints = number | 'infinite' | null;
export class AbilityTipPolicy {
  private hardEnd = 0;
  private allocated = 0;
  points: AbilityPoints = null;
  begin(now: number, maxMs: number, allocated: number) {
    this.hardEnd = now + maxMs;
    this.allocated = allocated;
    this.points = null;
  }
  update(points: AbilityPoints, fallbackEnd: number): number | null {
    this.points = points;
    if (points === 'infinite' || points === 0) return null;
    if (typeof points === 'number') {
      const spendable = canSpendAbilityPoints(this.allocated, points);
      if (spendable === false) return null;
      if (spendable === true) return this.hardEnd;
    }
    return Math.min(fallbackEnd, this.hardEnd);
  }
}
