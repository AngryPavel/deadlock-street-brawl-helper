import type { Item } from '../types';

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

/** Signed API deltas applied to enemies; negative resistance/power is beneficial to us. */
const ENEMY_DELTAS = new Set(['BulletArmorReduction', 'MagicResistReduction', 'TechPowerReduction']);
const DIMINISHING = new Set([
  'BulletResist',
  'TechResist',
  'CooldownReduction',
  'BulletLifestealPercent',
  'AbilityLifestealPercentHero',
  'StatusResistancePercent',
  'SlowResistancePercent',
]);

export interface EnhancedScoring {
  /** Overrides are local assumptions unless their provenance is independently verified. */
  statMultiplier?: number;
  scoreBonus?: number;
  itemOverrides?: Record<number, { statMultiplier?: number; scoreBonus?: number; properties?: Item['properties'] }>;
}

export interface StatContribution {
  property: string;
  value: number;
  applicability: 'innate' | 'conditional' | 'unspecified';
  condition?: string;
}

export function statContributions(item: Item, mult: Record<string, number>): StatContribution[] {
  return Object.entries(item.properties).flatMap(([key, property]) => {
    if (!UNIT_VALUE[key]) return [];
    const sections = item.tooltip_sections.filter((section) =>
      section.section_attributes?.some((attribute) =>
        [
          ...(attribute.properties ?? []),
          ...(attribute.elevated_properties ?? []),
          ...(attribute.important_properties ?? []),
        ].includes(key),
      ),
    );
    const innate = sections.some((section) => section.section_type === 'innate');
    const conditional = !innate && sections.length > 0;
    return [
      {
        property: key,
        value: num(property.value) * (ENEMY_DELTAS.has(key) ? -1 : 1) * UNIT_VALUE[key] * (mult[key] ?? 1),
        applicability: innate ? ('innate' as const) : conditional ? ('conditional' as const) : ('unspecified' as const),
        condition: conditional
          ? sections
              .flatMap((section) => section.section_attributes ?? [])
              .map((attribute) => attribute.loc_string?.replace(/<[^>]*>/g, ''))
              .filter(Boolean)
              .join(' ') || 'requires item activation or proc'
          : undefined,
      },
    ];
  });
}

/** Conditional positives have unknown uptime and are not counted as permanent stats. Penalties keep their sign. */
export function statValue(item: Item, mult: Record<string, number>): number {
  return statContributions(item, mult).reduce(
    (sum, row) => sum + (row.applicability === 'conditional' && row.value > 0 ? 0 : row.value),
    0,
  );
}

/** A diminishing-returns heuristic, not a measured stacking formula. Linear damage/health still scale with kit. */
export function buildStatMultipliers(item: Item, owned: Item[], kit: Record<string, number>): Record<string, number> {
  const out = { ...kit };
  for (const key of DIMINISHING) {
    const offered = num(item.properties[key]?.value);
    if (offered <= 0) continue;
    const held = owned.reduce((sum, other) => sum + Math.max(0, num(other.properties[key]?.value)), 0);
    out[key] = (kit[key] ?? 1) / (1 + held / offered);
  }
  return out;
}

/** Shared counter functions reduce marginal value; absence of metadata does not imply a counter. */
export function counterEffects(item: Item): string[] {
  const keys = Object.keys(item.properties).filter((key) => num(item.properties[key].value) !== 0);
  const effects = new Set<string>();
  for (const key of keys) {
    if (/HealAmp.*Penalty/.test(key)) effects.add('healing reduction');
    if (/Silence|EMPDuration/.test(key)) effects.add('silence');
    if (/Disarm/.test(key)) effects.add('disarm');
    if (/SlowPercent|FireRateSlow/.test(key)) effects.add('slow');
    if (key === 'BulletArmorReduction') effects.add('bullet resistance reduction');
    if (key === 'MagicResistReduction') effects.add('spirit resistance reduction');
    if (key === 'TechPowerReduction') effects.add('spirit power reduction');
  }
  return [...effects];
}

export function counterMarginal(item: Item, owned: Item[]): number {
  const effects = counterEffects(item);
  if (!effects.length) return 1;
  return (
    effects.reduce(
      (sum, effect) => sum + 1 / (1 + owned.filter((other) => counterEffects(other).includes(effect)).length),
      0,
    ) / effects.length
  );
}
