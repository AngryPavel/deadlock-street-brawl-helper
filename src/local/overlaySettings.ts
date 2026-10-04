export interface OverlaySettings {
  detail: 'detailed' | 'compact';
  abilityTipMode: 'points' | 'fixed';
  tipSeconds: number;
  pointLimitSeconds: number;
}
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  detail: 'detailed',
  abilityTipMode: 'points',
  tipSeconds: 15,
  pointLimitSeconds: 60,
};
export function isOverlaySettings(value: unknown): value is OverlaySettings {
  if (!value || typeof value !== 'object') return false;
  const v = value as OverlaySettings;
  return (
    (v.detail === 'detailed' || v.detail === 'compact') &&
    (v.abilityTipMode === 'points' || v.abilityTipMode === 'fixed') &&
    Number.isInteger(v.tipSeconds) &&
    v.tipSeconds >= 5 &&
    v.tipSeconds <= 120 &&
    Number.isInteger(v.pointLimitSeconds) &&
    v.pointLimitSeconds >= 5 &&
    v.pointLimitSeconds <= 180
  );
}
/** Only a confirmed positive on-screen count can authorize spending a reroll. */
export function availableReroll<T>(advice: T | null | undefined, count: number | null | undefined): T | null {
  return count !== null && count !== undefined && Number.isInteger(count) && count > 0 ? (advice ?? null) : null;
}
