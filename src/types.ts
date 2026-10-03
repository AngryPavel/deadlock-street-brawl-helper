export type SlotType = 'weapon' | 'vitality' | 'spirit';

interface ItemProperty {
  value: string | number;
  label?: string;
  postfix?: string;
  prefix?: string;
  css_class?: string;
}

export interface Item {
  id: number;
  class_name: string;
  name: string;
  cost: number;
  item_tier: number;
  item_slot_type: SlotType;
  shopable: boolean;
  disabled: boolean;
  is_active_item: boolean;
  activation?: string;
  component_items: string[];
  shop_image_webp?: string;
  image_webp?: string;
  description: { desc?: string; active?: string; passive?: string; [k: string]: string | undefined };
  tooltip_sections: TooltipSection[];
  properties: Record<string, ItemProperty>;
}
interface TooltipSection {
  section_type?: string;
  section_attributes?: {
    properties?: string[];
    elevated_properties?: string[];
    important_properties?: string[];
    loc_string?: string;
  }[];
}

export interface Hero {
  id: number;
  name: string;
  class_name: string;
  description?: { role?: string; playstyle?: string; lore?: string };
  images: { small?: string; card?: string };
  starting_stats: Record<string, number>;
  standard_level_up_upgrades: Record<string, number>;
  level_info: Record<string, { required_gold?: number; bonus_currencies?: string[] }>;
  abilities: string[]; // class names of signature1..4
  gun_tag?: string;
  tags?: string[];
}

export interface Ability {
  id: number;
  class_name: string;
  name: string;
  hero: number;
  image_webp?: string;
  ability_type?: string;
  description: string;
  upgrades: { name: string; bonus: string }[][];
  properties: Record<string, { value: string | number; scale: string | string[] | null }>;
}

export interface ItemStat {
  item_id: number;
  wins: number;
  losses: number;
  matches: number;
  players: number;
  avg_buy_time_s: number;
  avg_sell_time_s: number;
  avg_buy_time_relative: number;
  avg_sell_time_relative: number;
}
export interface AbilityOrderStat {
  abilities: number[];
  wins: number;
  losses: number;
  matches: number;
  players: number;
}
export interface PairStat {
  item_ids: number[];
  wins: number;
  losses: number;
  matches: number;
}
export interface AbilityStep {
  ability: Ability;
  kind: 'tier1' | 'tier2' | 'tier3';
  index: number;
}
