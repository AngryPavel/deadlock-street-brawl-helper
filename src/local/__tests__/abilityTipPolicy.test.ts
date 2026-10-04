import { describe, expect, it } from 'vitest';
import { AbilityTipPolicy, canSpendAbilityPoints } from '../abilityTipPolicy';
import { CLOSE_FRAMES, initialTip, stepTip } from '../../brawl/abilityPanelTimer';

describe('HUD-driven ability tip', () => {
  it('extends a confirmed spendable bank but never renews the maximum deadline', () => {
    const policy = new AbilityTipPolicy();
    policy.begin(1000, 60_000, 6);
    expect(policy.update(null, 16_000)).toBe(16_000);
    expect(policy.update(6, 16_000)).toBe(61_000);
    expect(policy.update(3, 61_000)).toBe(61_000);
    expect(policy.update(1, 61_000)).toBe(61_000);
    expect(policy.update(0, 61_000)).toBeNull();
  });
  it('hides at zero, lobby infinity, all upgrades purchased and an unaffordable leftover bank', () => {
    const policy = new AbilityTipPolicy();
    policy.begin(0, 60_000, 40);
    expect(policy.update(8, 15_000)).toBeNull(); // 32 spent, bonus points remain.
    expect(policy.update('infinite', 15_000)).toBeNull();
    expect(policy.update(0, 15_000)).toBeNull();
    policy.begin(0, 60_000, 29);
    expect(policy.update(2, 15_000)).toBeNull(); // 8+8+8+3 spent; next tier costs 5.
  });
  it('does not claim to know purchased tiers from an ambiguous bank or inconsistent allocation', () => {
    expect(canSpendAbilityPoints(6, 2)).toBe(true); // Some compatible builds can buy a tier.
    expect(canSpendAbilityPoints(6, 9)).toBeNull(); // Wrong round/bonus point evidence.
    const policy = new AbilityTipPolicy();
    policy.begin(0, 60_000, 6);
    expect(policy.update(9, 15_000)).toBe(15_000);
  });
  it('does not reappear after spending points; a new draft permits a new tip', () => {
    let state = stepTip(initialTip<string>(), true, 0, 'Afterburn');
    for (let i = 0; i < CLOSE_FRAMES; i++) state = stepTip(state, false, 1000, 'Afterburn');
    expect(state.tip).not.toBeNull();
    state = { ...state, tip: null };
    expect(stepTip(state, false, 2000, 'Afterburn').tip).toBeNull();
    state = stepTip(state, true, 3000, 'Afterburn');
    for (let i = 0; i < CLOSE_FRAMES; i++) state = stepTip(state, false, 4000, 'Afterburn');
    expect(state.tip).not.toBeNull();
  });
});
