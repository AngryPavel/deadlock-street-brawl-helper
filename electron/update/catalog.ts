import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Hero, Item, Ability } from '../../src/types';
import type { IconIndex } from '../../src/brawl/types';
// Asset API records contain nested, optional metadata; slim them at the boundary as the release fetcher does.
type Raw = Record<string, any>;
export interface CatalogHttp {
  json<T>(url: string): Promise<T>;
  bytes(url: string): Promise<Buffer>;
}
const API = 'https://api.deadlock-api.com/v1/assets';
export async function saveJson(dir: string, rel: string, value: unknown) {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
function slimItem(it: Raw) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries<Raw>(it.properties || {})) {
    props[k] = { value: v.value, label: v.label, postfix: v.postfix, prefix: v.prefix, css_class: v.css_class };
  }
  return {
    id: it.id,
    class_name: it.class_name,
    name: it.name,
    cost: it.cost ?? 0,
    item_tier: it.item_tier,
    item_slot_type: it.item_slot_type,
    shopable: !!it.shopable,
    disabled: !!it.disabled,
    is_active_item: !!it.is_active_item,
    activation: it.activation,
    component_items: it.component_items || [],
    shop_image_webp: it.shop_image_webp || it.image_webp,
    image_webp: it.image_webp,
    description: it.description || {},
    tooltip_sections: it.tooltip_sections || [],
    properties: props,
  };
}

function slimHero(h: Raw) {
  return {
    id: h.id,
    name: h.name,
    class_name: h.class_name,
    description: h.description,
    images: { small: h.images?.icon_image_small_webp, card: h.images?.icon_hero_card_webp },
    starting_stats: Object.fromEntries(Object.entries<Raw>(h.starting_stats || {}).map(([k, v]) => [k, v.value])),
    standard_level_up_upgrades: h.standard_level_up_upgrades || {},
    level_info: h.level_info || {},
    abilities: [h.items?.signature1, h.items?.signature2, h.items?.signature3, h.items?.signature4].filter(Boolean),
    gun_tag: h.gun_tag,
    tags: h.tags,
  };
}

function slimAbility(a: Raw) {
  return {
    id: a.id,
    class_name: a.class_name,
    name: a.name,
    hero: a.hero,
    image_webp: a.image_webp,
    ability_type: a.ability_type,
    description: a.description?.desc || '',
    upgrades: (a.upgrades || []).map((u: Raw) =>
      (u.property_upgrades || []).map((p: Raw) => ({ name: p.name, bonus: String(p.bonus) })),
    ),
    properties: Object.fromEntries(
      Object.entries<Raw>(a.properties || {})
        .filter(([, v]) => v && v.value !== undefined)
        .map(([k, v]) => [
          k,
          {
            value: v.value,
            scale: v.scale_function?.specific_stat_scale_type || v.scale_function?.scaling_stats || null,
          },
        ]),
    ),
  };
}

export async function fetchCatalog(
  dir: string,
  http: CatalogHttp,
  signal: AbortSignal,
  report: (done: number, total: number, message: string) => void,
  warn: (message: string) => void,
) {
  const rawItems = await http.json<Raw[]>(`${API}/items/by-type/upgrade`);
  const rawHeroes = await http.json<Raw[]>(`${API}/heroes`);
  const rawAbilities = await http.json<Raw[]>(`${API}/items/by-type/ability`);
  if (!Array.isArray(rawItems) || !Array.isArray(rawHeroes) || !Array.isArray(rawAbilities))
    throw new Error('Invalid asset catalog.');
  const items = rawItems.map(slimItem);
  const heroes = rawHeroes.filter((h) => h.player_selectable && !h.disabled && !h.in_development).map(slimHero);
  if (!heroes.length || !items.length) throw new Error('The asset catalog is empty.');
  const ids = new Set(heroes.map((h) => h.id));
  const abilities = rawAbilities.filter((a) => ids.has(a.hero)).map(slimAbility);
  const signatures = new Set(heroes.flatMap((h) => h.abilities));
  const jobs: { url: string | undefined; rel: string; apply: (rel: string) => void }[] = [];
  for (const it of items) {
    const remote = it.shop_image_webp;
    Object.assign(it, { remote_shop_image: remote });
    jobs.push({
      url: remote,
      rel: `img/items/${it.id}.webp`,
      apply: (rel) => {
        it.shop_image_webp = it.image_webp = rel;
      },
    });
  }
  for (const h of heroes)
    for (const [key, suffix] of [
      ['small', ''],
      ['card', '-card'],
    ] as const)
      jobs.push({
        url: h.images[key],
        rel: `img/heroes/${h.id}${suffix}.webp`,
        apply: (rel) => {
          h.images[key] = rel;
        },
      });
  for (const a of abilities)
    if (signatures.has(a.class_name))
      jobs.push({
        url: a.image_webp,
        rel: `img/abilities/${a.id}.webp`,
        apply: (rel) => {
          a.image_webp = rel;
        },
      });
  let completed = 0;
  // Serial assets keep resource usage low while a game is running; every image is decoded before installation.
  for (const job of jobs) {
    signal.throwIfAborted();
    let usable = false;
    if (job.url)
      try {
        const bytes = await http.bytes(job.url);
        const meta = await sharp(bytes).metadata();
        if (!meta.width || !meta.height) throw new Error('Empty image.');
        const file = path.join(dir, job.rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
        usable = true;
      } catch (error) {
        signal.throwIfAborted();
        warn(`Could not refresh ${job.rel}; retaining its previous image when available. ${String(error)}`);
      }
    if (!usable)
      try {
        await sharp(path.join(dir, job.rel)).metadata();
        usable = true;
      } catch {
        /* missing asset: OCR fallback remains available */
      }
    if (usable) job.apply(job.rel);
    else warn(`No image for ${job.rel}. Item-name recognition can recover draft cards.`);
    report(++completed, jobs.length, `Images: ${completed}/${jobs.length} · ${job.rel}`);
  }
  await saveJson(dir, 'items.json', items);
  await saveJson(dir, 'heroes.json', heroes);
  await saveJson(dir, 'abilities.json', abilities);
  return { items: items as Item[], heroes: heroes as Hero[], abilities: abilities as Ability[] };
}

export async function buildIconIndex(
  dir: string,
  items: Item[],
  heroes: Hero[],
  previous: IconIndex,
  signal: AbortSignal,
) {
  const icons: Record<string, string> = {},
    hashes = new Map<string, number[]>(),
    portraits: Record<string, string> = {};
  for (const item of items.filter((i) => !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name))) {
    signal.throwIfAborted();
    try {
      const bytes = await readFile(path.join(dir, `img/items/${item.id}.webp`));
      const hash = createHash('md5').update(bytes).digest('hex');
      hashes.set(hash, [...(hashes.get(hash) ?? []), item.id]);
      icons[item.id] = (
        await sharp(bytes)
          .flatten({ background: '#ebe8e2' })
          .resize(24, 24, { fit: 'fill', kernel: 'lanczos3' })
          .removeAlpha()
          .raw()
          .toBuffer()
      ).toString('base64');
    } catch {
      /* no icon: retain catalog name for OCR */
    }
  }
  for (const hero of heroes) {
    signal.throwIfAborted();
    try {
      const file = path.join(dir, `img/heroes/${hero.id}-card.webp`),
        meta = await sharp(file).metadata();
      const side = meta.width!,
        top = Math.round(meta.height! * (hero.class_name === 'hero_gigawatt' ? 0.2 : 0.1));
      portraits[hero.id] = (
        await sharp(file)
          .extract({ left: 0, top, width: side, height: side })
          .flatten({ background: '#3a4a58' })
          .resize(24, 24, { fit: 'fill', kernel: 'lanczos3' })
          .removeAlpha()
          .raw()
          .toBuffer()
      ).toString('base64');
    } catch {
      /* missing portrait is explicitly unread */
    }
  }
  const twins: Record<string, number[]> = {};
  for (const group of hashes.values())
    if (group.length > 1) for (const id of group) twins[id] = group.filter((x) => x !== id);
  const names = Object.fromEntries(items.filter((i) => !i.disabled && i.item_tier >= 1).map((i) => [i.id, i.name]));
  await saveJson(dir, 'brawl-icons.json', {
    size: 24,
    background: '#ebe8e2',
    icons,
    twins,
    heroes: portraits,
    names,
    extras: (previous.extras ?? []).filter(([id]) => items.some((i) => i.id === id && !i.disabled)),
  });
}
