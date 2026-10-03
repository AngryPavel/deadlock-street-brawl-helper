// Shared by scripts/brawl-recognise.ts (`--fixtures`) and src/brawl/__tests__/recognise.test.ts, so the
// CLI's accuracy report and the automated test run the exact same matching logic against the exact same
// fixture files, rather than the test re-implementing a copy that could drift from the CLI's.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { matchIcon, readMarkers, readTier, resolveTwin, type DecodedIndex, type RGBImage } from '../src/brawl';

const FIX = 'scripts/fixtures/brawl-cards';

export interface FixtureLabel {
  item_id: number;
  name: string;
  icon: number;
  rare?: boolean;
  enhanced?: boolean;
}

export interface FixtureResult {
  key: string;
  label: FixtureLabel;
  hit: boolean;
  gotId: number;
  tier: number;
  rare: boolean;
  enhanced: boolean;
  score: number;
  margin: number;
  rareFrac: number;
  enhancedFrac: number;
}

const load = async (p: string): Promise<RGBImage> => {
  const { data, info } = await sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width!, height: info.height!, data, channels: 3 };
};

export function readFixtureLabels(): Record<string, FixtureLabel> {
  return JSON.parse(readFileSync(`${FIX}/labels.json`, 'utf8'));
}

/** Matches every labelled fixture card against the icon index, alternating RGB and RGBA decoding (the browser
 *  canvas hands over RGBA) so both code paths get covered. */
export async function checkFixtures(index: DecodedIndex, tierOf: (id: number) => number): Promise<FixtureResult[]> {
  const labels = readFixtureLabels();
  const out: FixtureResult[] = [];
  let n = 0;
  for (const [key, l] of Object.entries(labels)) {
    const img = await load(`${FIX}/${key}.png`);
    if (n % 2) {
      const rgba = new Uint8Array(img.width * img.height * 4);
      for (let i = 0; i < img.width * img.height; i++) {
        rgba[i * 4] = img.data[i * 3];
        rgba[i * 4 + 1] = img.data[i * 3 + 1];
        rgba[i * 4 + 2] = img.data[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      img.data = rgba;
      img.channels = 4;
    }
    const m = matchIcon(img, index, img.width / 2, img.height / 2, l.icon);
    const tier = readTier(img, m);
    const mk = readMarkers(img, m);
    const id = resolveTwin(m.itemId, tier, index, tierOf);
    const hit = id === l.item_id && tier === tierOf(l.item_id) && mk.rare === !!l.rare && mk.enhanced === !!l.enhanced;
    out.push({
      key,
      label: l,
      hit,
      gotId: id,
      tier,
      rare: mk.rare,
      enhanced: mk.enhanced,
      score: m.score,
      margin: m.margin,
      rareFrac: mk.rareFrac,
      enhancedFrac: mk.enhancedFrac,
    });
    n++;
  }
  return out;
}
