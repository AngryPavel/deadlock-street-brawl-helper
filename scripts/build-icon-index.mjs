// Builds public/data/brawl-icons.json: every item icon (public/data/img/items/<id>.webp) flattened on a light
// card background and downsampled to ICON_PX x ICON_PX RGB, base64-encoded. The Street Brawl recogniser
// (src/brawl/recognise.ts) matches screen crops against this index. Run after fetch-data.
//   node scripts/build-icon-index.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const ICON_PX = 24;
const BG = '#ebe8e2'; // card face colour behind the icon on the draft screen
const dir = 'public/data/img/items';
const items = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const byId = new Map(items.map((i) => [i.id, i]));
const icons = {};
const hashes = new Map(); // md5 -> ids with an identical icon file
const usable = (i) => i && !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name);
for (const f of readdirSync(dir)
  .filter((f) => f.endsWith('.webp'))
  .sort()) {
  const id = Number(f.replace('.webp', ''));
  if (!usable(byId.get(id))) continue;
  const h = createHash('md5')
    .update(readFileSync(`${dir}/${f}`))
    .digest('hex');
  hashes.set(h, [...(hashes.get(h) ?? []), id]);
  const buf = await sharp(`${dir}/${f}`)
    .flatten({ background: BG })
    .resize(ICON_PX, ICON_PX, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer();
  icons[id] = buf.toString('base64');
}
// In-game art that differs from the shop art (e.g. Bullet Resilience): scripts/icon-extras/<itemId>.png, an icon-sized
// crop of a real draft frame. Each is matched as an extra reference for that item.
const extras = [];
const extraDir = 'scripts/icon-extras';
if (existsSync(extraDir))
  for (const f of readdirSync(extraDir).filter((f) => f.endsWith('.png'))) {
    const buf = await sharp(`${extraDir}/${f}`)
      .flatten({ background: BG })
      .resize(ICON_PX, ICON_PX, { fit: 'fill', kernel: 'lanczos3' })
      .removeAlpha()
      .raw()
      .toBuffer();
    extras.push([Number(f.replace('.png', '')), buf.toString('base64')]);
  }
// hero portraits: the draft screen's top bar shows each hero's card art cropped to a circle around the head;
// a square of the card's full width starting 10 % down matches those portraits best (see docs/street-brawl-plan.md)
const heroes = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const HERO_BG = '#3a4a58';
const portraits = {};
for (const h of heroes) {
  const f = `public/data/img/heroes/${h.id}-card.webp`;
  if (!existsSync(f)) continue;
  const meta = await sharp(f).metadata();
  const side = meta.width,
    top = Math.round(meta.height * 0.1);
  const buf = await sharp(f)
    .extract({ left: 0, top, width: side, height: side })
    .flatten({ background: HERO_BG })
    .resize(ICON_PX, ICON_PX, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer();
  portraits[h.id] = buf.toString('base64');
}
const twins = {};
for (const ids of hashes.values()) if (ids.length > 1) for (const id of ids) twins[id] = ids.filter((x) => x !== id);
writeFileSync(
  'public/data/brawl-icons.json',
  JSON.stringify({ size: ICON_PX, background: BG, icons, extras, twins, heroes: portraits }),
);
console.log(
  'twins:',
  [...hashes.values()]
    .filter((x) => x.length > 1)
    .map((ids) => ids.map((id) => byId.get(id).name).join(' = '))
    .join('; '),
);
console.log(
  `brawl-icons.json: ${Object.keys(icons).length} icons, ${Object.keys(portraits).length} hero portraits at ${ICON_PX}px`,
);
