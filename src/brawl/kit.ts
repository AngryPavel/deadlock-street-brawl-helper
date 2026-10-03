import type { Ability, Hero, Item } from '../types';

// Rough "souls per unit" of a stat: converts an item's raw stat lines into one soul-equivalent value.
const UNIT_VALUE: Record<string, number> = {
  BaseAttackDamagePercent: 55,
  BonusFireRate: 60,
  BonusClipSizePercent: 20,
  BulletLifestealPercent: 45,
  BonusBulletSpeedPercent: 8,
  BulletArmorReduction: 45,
  NonPlayerBonusWeaponPower: 12,
  TechPower: 60,
  TechPowerPercent: 50,
  SpiritPower: 60,
  BonusSpirit: 60,
  AbilityLifestealPercentHero: 45,
  CooldownReduction: 70,
  TechRangeMultiplier: 40,
  TechRadiusMultiplier: 30,
  BonusAbilityDurationPercent: 50,
  MagicResistReduction: 45,
  TechPowerReduction: 30,
  BonusHealth: 6,
  BulletResist: 55,
  TechResist: 55,
  OutOfCombatHealthRegen: 30,
  BonusHealthRegen: 60,
  BonusMoveSpeed: 350,
  BonusSprintSpeed: 150,
  Stamina: 250,
  StatusResistancePercent: 25,
  SlowResistancePercent: 15,
  BonusMeleeDamagePercent: 12,
  MeleeResistPercent: 15,
  CombatBarrier: 4,
};

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^-\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Soul-equivalent value of an item's stat lines under a set of per-stat multipliers. */
export function statValue(item: Item, mult: Record<string, number>): number {
  let v = 0;
  for (const [k, p] of Object.entries(item.properties)) {
    const unit = UNIT_VALUE[k];
    if (!unit) continue;
    v += Math.abs(num(p.value)) * unit * (mult[k] ?? 1);
  }
  return v;
}

// Kit profile: per-stat multipliers describing what the hero's own kit scales with.
// Derived generically from the assets data (ability scaling functions, level-up growth,
// description keywords), plus a small documented override table for heroes we tuned.
export function kitProfile(hero: Hero, abilities: Ability[]): Record<string, number> {
  const w: Record<string, number> = {};
  const add = (k: string, v: number) => {
    w[k] = (w[k] ?? 1) + v;
  };
  const sig = abilities.filter((a) => hero.abilities.includes(a.class_name));
  let techScaled = 0,
    bulletish = 0,
    durationish = 0;
  for (const a of sig) {
    for (const p of Object.values(a.properties)) {
      const s = Array.isArray(p.scale) ? p.scale.join(',') : (p.scale ?? '');
      if (s.includes('ETechPower')) techScaled++;
      if (s.includes('ETechDuration')) durationish++;
    }
    const t = a.description.toLowerCase();
    if (/bullet|weapon|fire rate|gun|shoot|ammo/.test(t)) bulletish++;
  }
  add('TechPower', Math.min(0.6, techScaled * 0.08));
  add('TechPowerPercent', Math.min(0.6, techScaled * 0.08));
  add('BonusAbilityDurationPercent', Math.min(0.3, durationish * 0.05));
  add('BonusFireRate', Math.min(0.5, bulletish * 0.15));
  add('BaseAttackDamagePercent', Math.min(0.5, bulletish * 0.15));
  // Level growth from assets: heroes with high bullet-damage growth like weapon items more,
  // high tech-power growth like spirit items more.
  const g = hero.standard_level_up_upgrades;
  const bulletGrowth = g['MODIFIER_VALUE_BASE_BULLET_DAMAGE_FROM_LEVEL'] ?? 0; // typically 0.05..0.15
  const techGrowth = g['MODIFIER_VALUE_TECH_POWER'] ?? 0; // typically 0.5..2
  add('BaseAttackDamagePercent', Math.min(0.4, bulletGrowth * 3));
  add('TechPower', Math.min(0.4, techGrowth * 0.2));
  Object.assign(w, OVERRIDES[hero.id] ?? {});
  return w;
}

// Hand-tuned kit hints. Infernus: Afterburn is a bullet-applied burn that
// scales with spirit power; Flame Dash/Napalm are spirit DoTs; fire-rate items feed Afterburn stacks.
const OVERRIDES: Record<number, Record<string, number>> = {
  1: {
    TechPower: 1.6,
    TechPowerPercent: 1.5,
    BonusFireRate: 1.5,
    BulletLifestealPercent: 1.3,
    BonusAbilityDurationPercent: 1.4,
    AbilityLifestealPercentHero: 1.3,
    CooldownReduction: 1.2,
    BonusMoveSpeed: 1.2,
  },
};
