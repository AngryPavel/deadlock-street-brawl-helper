// Data pipeline: snapshots every remote input the app needs into public/data/.
// After one successful run the app works fully offline.
//
// Outputs
//   public/data/items.json                 item catalog (all upgrade items)
//   public/data/heroes.json                active heroes with base stats + growth
//   public/data/abilities.json             abilities of active heroes (names, upgrades)
//   public/data/img/{items,heroes,abilities}/  webp images so the app needs no network at all
//   public/data/brawl-config.json          Street Brawl mode constants (round budgets, draft tiers/weights)
//   public/data/analytics/brawl/<hero_id>.json  Street Brawl item-stats, pair stats, and item-stats vs every enemy hero
//   public/data/analytics/brawl/tier-list.json  Street Brawl hero win/pick totals + item totals summed over every hero
//   public/data/manifest.json              timestamps + counts
//
// Flags (none = catalog + Street Brawl snapshot)
//   --brawl                     refresh the Street Brawl snapshot only
//   --catalog                   refresh items, heroes, abilities and their images only (no analytics)
//   --brawl-tierlist            rebuild analytics/brawl/tier-list.json only (one request + the files already on disk)
//   --brawl-abilities           refresh ability_order_stats in every analytics/brawl/<id>.json only
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.deadlock-api.com';
const ASSETS = `${API}/v1/assets`; // assets.deadlock-api.com no longer resolves; the same data lives under /v1/assets
const OUT = path.resolve('public/data');
// Analytics window: last 30 days (live data; the window is recorded in manifest.json).
const WINDOW_DAYS = 30;
// `--brawl` refreshes only the Street Brawl snapshot (brawl-config.json, analytics/brawl/*).
const CATALOG_ONLY = process.argv.includes('--catalog');
const BRAWL_ONLY = process.argv.includes('--brawl');
// `--brawl-tierlist` rebuilds analytics/brawl/tier-list.json alone: one hero-stats call plus a sum over
// the per-hero files already on disk, instead of the ~1400 requests a full --brawl run costs.
const BRAWL_TIERLIST_ONLY = process.argv.includes('--brawl-tierlist');
// `--brawl-abilities` refreshes only ability_order_stats in every analytics/brawl/<id>.json (~1 request
// per hero) and leaves the rest of each file untouched, instead of the full ~1400-request --brawl run.
const BRAWL_ABILITIES_ONLY = process.argv.includes('--brawl-abilities');
// Longest retry-after honoured on a 429; a longer one throws instead of stalling the run.
const MAX_WAIT_MS = 60_000;
// Street Brawl analytics: the API has no rank filter for this mode (400 "Cannot filter by average badge"),
// so there is one all-rank population. Enemy-filtered item-stats are fetched for every hero as the counter term.
const BRAWL_GAME_MODE = 'street_brawl';
let MIN_TS = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
// Street Brawl pins both ends of the window. The tier list divides item matches from the per-hero files by
// hero counts from a live hero-stats call, so those two have to cover exactly the same matches: with the
// upper end open, a tier-list rebuild days later counts hero-games the item files never saw and understates
// every usage figure.
let MAX_TS = null;
const windowQ = () => `min_unix_timestamp=${MIN_TS}${MAX_TS ? `&max_unix_timestamp=${MAX_TS}` : ''}`;
// Rate limit is 200 req / 60 s -> ~350 ms between requests keeps us well under.
const SLEEP_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 429 || res.status >= 500) {
        const asked = Number(res.headers.get('retry-after') || 0) * 1000 || 2000 * (i + 1);
        if (res.status === 429 && asked > MAX_WAIT_MS)
          throw new Error(`429 retry-after ${Math.round(asked / 1000)}s for ${url}`);
        const wait = Math.min(MAX_WAIT_MS, asked);
        console.warn(`  ${res.status} on ${url} – waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const j = await res.json();
      await sleep(SLEEP_MS);
      return j;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  // Every attempt was a 429 or a 5xx. Throwing here is what keeps a rate-limited run honest: returning
  // undefined made callers fail on `.map` of undefined, and the one caller with a try/catch (the enemy
  // matchups) logged that as a per-enemy failure and wrote the snapshot without them.
  throw new Error(`gave up after ${tries} rate-limited or failing attempts for ${url}`);
}

// Downloads an image once into public/data/img/<dir>/<id>.webp and returns the app-relative path.
async function saveImage(url, dir, id, suffix = '') {
  if (!url) return undefined;
  const rel = `img/${dir}/${id}${suffix}.webp`;
  const f = path.join(OUT, rel);
  await mkdir(path.dirname(f), { recursive: true });
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status}`);
    await writeFile(f, Buffer.from(await res.arrayBuffer()));
    await sleep(40);
    return rel;
  } catch (e) {
    console.warn(`  image failed ${url}: ${e.message}`);
    return undefined;
  }
}

const save = async (rel, data) => {
  const f = path.join(OUT, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(data));
  console.log(`wrote ${rel}`);
};

// Keep only fields the app needs; the SVG-heavy description blobs are kept
// because the item card renders their text.
function slimItem(it) {
  const props = {};
  for (const [k, v] of Object.entries(it.properties || {})) {
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

function slimHero(h) {
  return {
    id: h.id,
    name: h.name,
    class_name: h.class_name,
    description: h.description,
    images: { small: h.images?.icon_image_small_webp, card: h.images?.icon_hero_card_webp },
    starting_stats: Object.fromEntries(Object.entries(h.starting_stats || {}).map(([k, v]) => [k, v.value])),
    standard_level_up_upgrades: h.standard_level_up_upgrades || {},
    level_info: h.level_info || {},
    abilities: [h.items?.signature1, h.items?.signature2, h.items?.signature3, h.items?.signature4].filter(Boolean),
    gun_tag: h.gun_tag,
    tags: h.tags,
  };
}

function slimAbility(a) {
  return {
    id: a.id,
    class_name: a.class_name,
    name: a.name,
    hero: a.hero,
    image_webp: a.image_webp,
    ability_type: a.ability_type,
    description: a.description?.desc || '',
    upgrades: (a.upgrades || []).map((u) =>
      (u.property_upgrades || []).map((p) => ({ name: p.name, bonus: String(p.bonus) })),
    ),
    properties: Object.fromEntries(
      Object.entries(a.properties || {})
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

// One row per item, slimmed to what the counter term needs.
const slimStat = (s) => ({ item_id: s.item_id, wins: s.wins, matches: s.matches });

// Ability sequences can be large (10k+ rows); keep the 200 most-played.
async function fetchBrawlAbilityOrder(q) {
  const rows = await getJson(`${API}/v1/analytics/ability-order-stats?${q}&min_matches=5`);
  return [...rows].sort((a, b) => b.matches - a.matches).slice(0, 200);
}

async function fetchBrawl(heroes, manifest) {
  // Pin the window for a brawl run reached from the full pipeline too, and take both ends from the clock here:
  // the earlier steps can run for hours, so the module-load MIN_TS would make the span wider than WINDOW_DAYS.
  if (MAX_TS === null) {
    MAX_TS = Math.floor(Date.now() / 1000);
    MIN_TS = MAX_TS - WINDOW_DAYS * 86400;
  }
  console.log(`brawl 1/2 mode config`);
  const generic = await getJson(`${ASSETS}/generic-data`);
  await save('brawl-config.json', { fetched_at: new Date().toISOString(), ...generic.street_brawl });
  console.log(`brawl 2/2 per-hero Street Brawl analytics (${heroes.length} heroes x ${heroes.length} enemies)`);
  for (const h of heroes) {
    const q = `hero_id=${h.id}&game_mode=${BRAWL_GAME_MODE}&${windowQ()}`;
    const item_stats = await getJson(`${API}/v1/analytics/item-stats?${q}`);
    const perm = await getJson(`${API}/v1/analytics/item-permutation-stats?${q}&comb_size=2`);
    const permutation_stats = [...perm].sort((a, b) => b.matches - a.matches).slice(0, 600);
    const ability_order_stats = await fetchBrawlAbilityOrder(q);
    const vs = {};
    for (const e of heroes) {
      if (e.id === h.id) continue;
      try {
        vs[e.id] = (await getJson(`${API}/v1/analytics/item-stats?${q}&enemy_hero_ids=${e.id}`)).map(slimStat);
      } catch (err) {
        console.warn(`  vs ${e.name} failed: ${err.message}`);
      }
    }
    const maxM = Math.max(0, ...item_stats.map((s) => s.matches));
    console.log(
      `   ${h.name}: max item matches ${maxM}, ${item_stats.length} items, ${Object.keys(vs).length} enemies, ${ability_order_stats.length} ability sequences`,
    );
    await save(`analytics/brawl/${h.id}.json`, {
      hero_id: h.id,
      game_mode: BRAWL_GAME_MODE,
      item_stats,
      permutation_stats,
      ability_order_stats,
      vs,
    });
  }
  manifest.brawl = {
    fetched_at: new Date().toISOString(),
    game_mode: BRAWL_GAME_MODE,
    heroes: heroes.length,
    min_unix_timestamp: MIN_TS,
    max_unix_timestamp: MAX_TS,
    window_days: Math.round((MAX_TS - MIN_TS) / 86400),
  };
  await buildTierList(heroes, manifest);
}

// Tier-list snapshot: one small file the app can load on its own, instead of the 38 per-hero files.
// Heroes come straight from hero-stats; items are the per-hero item_stats summed over every hero, so
// an item's win rate is its rate across the whole mode and its usage is the share of hero-games it appeared in.
async function buildTierList(heroes, manifest) {
  console.log('brawl tier list: hero-stats + item totals');
  const rows = await getJson(`${API}/v1/analytics/hero-stats?game_mode=${BRAWL_GAME_MODE}&${windowQ()}`);
  const active = new Set(heroes.map((h) => h.id));
  const heroStats = rows
    .filter((r) => active.has(r.hero_id))
    .map((r) => ({ hero_id: r.hero_id, wins: r.wins, losses: r.losses, matches: r.matches }));
  const totals = new Map();
  let heroGames = 0;
  for (const h of heroes) {
    let file;
    try {
      file = JSON.parse(await readFile(path.join(OUT, `analytics/brawl/${h.id}.json`), 'utf8'));
    } catch {
      console.warn(`  no brawl snapshot for ${h.name}; skipped`);
      continue;
    }
    heroGames += heroStats.find((s) => s.hero_id === h.id)?.matches ?? 0;
    for (const s of file.item_stats) {
      const t = totals.get(s.item_id) ?? { item_id: s.item_id, wins: 0, losses: 0, matches: 0, players: 0 };
      t.wins += s.wins;
      t.losses += s.losses;
      t.matches += s.matches;
      t.players += s.players;
      totals.set(s.item_id, t);
    }
  }
  const items = [...totals.values()].sort((a, b) => b.matches - a.matches);
  await save('analytics/brawl/tier-list.json', {
    fetched_at: new Date().toISOString(),
    game_mode: BRAWL_GAME_MODE,
    // the window the numbers actually cover, not the nominal one: a rebuilt tier list inherits the window
    // its per-hero files were fetched with, which is what makes hero_games the right denominator for them
    min_unix_timestamp: MIN_TS,
    max_unix_timestamp: MAX_TS,
    window_days: MAX_TS ? Math.round((MAX_TS - MIN_TS) / 86400) : (manifest.window_days ?? WINDOW_DAYS),
    hero_games: heroGames,
    heroes: heroStats,
    items,
  });
  manifest.brawl_tier_list = { fetched_at: new Date().toISOString(), heroes: heroStats.length, items: items.length };
}

async function main() {
  if (BRAWL_ABILITIES_ONLY) {
    const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    const heroes = JSON.parse(await readFile(path.join(OUT, 'heroes.json'), 'utf8'));
    MIN_TS = manifest.brawl?.min_unix_timestamp ?? manifest.min_unix_timestamp;
    MAX_TS = manifest.brawl?.max_unix_timestamp ?? Math.floor(Date.now() / 1000);
    console.log(`brawl abilities: ${heroes.length} heroes`);
    for (const h of heroes) {
      const q = `hero_id=${h.id}&game_mode=${BRAWL_GAME_MODE}&${windowQ()}`;
      const ability_order_stats = await fetchBrawlAbilityOrder(q);
      const file = JSON.parse(await readFile(path.join(OUT, `analytics/brawl/${h.id}.json`), 'utf8'));
      console.log(`   ${h.name}: ${ability_order_stats.length} ability sequences`);
      await save(`analytics/brawl/${h.id}.json`, { ...file, ability_order_stats });
    }
    if (manifest.brawl) manifest.brawl.abilities_fetched_at = new Date().toISOString();
    await save('manifest.json', manifest);
    return;
  }
  if (BRAWL_TIERLIST_ONLY) {
    const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    const heroes = JSON.parse(await readFile(path.join(OUT, 'heroes.json'), 'utf8'));
    // Exactly the window the per-hero files it sums were fetched with, both ends. Snapshots written before
    // the window was pinned recorded only the lower end, so fall back to when the brawl files were fetched.
    MIN_TS = manifest.brawl?.min_unix_timestamp ?? manifest.min_unix_timestamp;
    MAX_TS =
      manifest.brawl?.max_unix_timestamp ??
      Math.floor(Date.parse(manifest.brawl?.fetched_at ?? manifest.fetched_at) / 1000);
    await buildTierList(heroes, manifest);
    await save('manifest.json', manifest);
    return;
  }
  if (BRAWL_ONLY) {
    const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    const heroes = JSON.parse(await readFile(path.join(OUT, 'heroes.json'), 'utf8'));
    // A brawl refresh takes a fresh window rather than inheriting the one the last full run froze into the
    // manifest, which otherwise widened on every run while every label still said WINDOW_DAYS.
    MAX_TS = Math.floor(Date.now() / 1000);
    MIN_TS = MAX_TS - WINDOW_DAYS * 86400;
    await fetchBrawl(heroes, manifest);
    await save('manifest.json', manifest);
    return;
  }
  await mkdir(OUT, { recursive: true });
  const manifest = {
    fetched_at: new Date().toISOString(),
    min_unix_timestamp: MIN_TS,
    window_days: WINDOW_DAYS,
    counts: {},
  };

  console.log('1/3 item catalog');
  const items = (await getJson(`${ASSETS}/items/by-type/upgrade`)).map(slimItem);
  console.log(`   downloading ${items.length} item images`);
  for (const it of items) {
    it.remote_shop_image = it.shop_image_webp;
    const local = await saveImage(it.shop_image_webp, 'items', it.id);
    if (local) {
      it.shop_image_webp = local;
      it.image_webp = local;
    }
  }
  await save('items.json', items);
  manifest.counts.items = items.length;
  manifest.counts.shopable_items = items.filter((i) => i.shopable && !i.disabled).length;

  console.log('2/3 heroes');
  const heroesRaw = await getJson(`${ASSETS}/heroes`);
  const active = heroesRaw.filter((h) => h.player_selectable && !h.disabled && !h.in_development);
  const heroes = active.map(slimHero);
  for (const h of heroes) {
    const l = await saveImage(h.images.small, 'heroes', h.id);
    if (l) h.images.small = l;
    // card art is what the Street Brawl draft screen shows in the top bar; the recogniser matches portraits against it
    const c = await saveImage(h.images.card, 'heroes', h.id, '-card');
    if (c) h.images.card = c;
  }
  await save('heroes.json', heroes);
  manifest.counts.heroes = heroes.length;

  console.log('3/3 abilities');
  const abilitiesRaw = await getJson(`${ASSETS}/items/by-type/ability`);
  const activeIds = new Set(active.map((h) => h.id));
  const abilities = abilitiesRaw.filter((a) => activeIds.has(a.hero)).map(slimAbility);
  const sigNames = new Set(heroes.flatMap((h) => h.abilities));
  for (const a of abilities)
    if (sigNames.has(a.class_name)) {
      const l = await saveImage(a.image_webp, 'abilities', a.id);
      if (l) a.image_webp = l;
    }
  await save('abilities.json', abilities);
  manifest.counts.abilities = abilities.length;

  if (CATALOG_ONLY) {
    const old = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    await save('manifest.json', {
      ...old,
      catalog_fetched_at: manifest.fetched_at,
      counts: { ...old.counts, ...manifest.counts },
    });
    console.log('done (catalog only)', manifest.counts);
    return;
  }
  await fetchBrawl(heroes, manifest);

  await save('manifest.json', manifest);
  console.log('done', manifest.counts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
