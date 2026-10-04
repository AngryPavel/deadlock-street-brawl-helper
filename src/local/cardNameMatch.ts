/** OCR confidence is diagnostic: catalogue identity comes from the complete, unambiguous string. */
export const normaliseCardName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface CardNameMatch {
  itemId: number;
  kind: 'exact' | 'corrected' | 'unknown';
  reason?: 'empty-text' | 'ambiguous-name' | 'non-exact-name';
}

/** Bounded full-string edits, including adjacent transpositions; never substring completion. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      let distance = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + Number(a[i - 1] !== b[j - 1]),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        distance = Math.min(distance, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = distance;
    }
  return rows[a.length]![b.length]!;
}

export function matchCardName(text: string, names: Record<string, string>): CardNameMatch {
  const query = normaliseCardName(text);
  if (!query) return { itemId: 0, kind: 'unknown', reason: 'empty-text' };
  const entries = Object.entries(names)
    .map(([id, name]) => ({ itemId: Number(id), name: normaliseCardName(name) }))
    .filter(({ itemId, name }) => Number.isSafeInteger(itemId) && itemId > 0 && !!name);
  const exact = entries.filter(({ name }) => name === query);
  if (exact.length)
    return exact.length === 1
      ? { itemId: exact[0]!.itemId, kind: 'exact' }
      : { itemId: 0, kind: 'unknown', reason: 'ambiguous-name' };
  const ranked = entries
    .map((entry) => ({ ...entry, distance: editDistance(query, entry.name) }))
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0];
  if (!best) return { itemId: 0, kind: 'unknown', reason: 'non-exact-name' };
  const length = Math.min(query.length, best.name.length);
  const radius = length >= 12 ? 2 : length >= 6 ? 1 : 0;
  if (!radius || best.distance > radius) return { itemId: 0, kind: 'unknown', reason: 'non-exact-name' };
  if ((ranked[1]?.distance ?? Infinity) < best.distance + 2)
    return { itemId: 0, kind: 'unknown', reason: 'ambiguous-name' };
  return { itemId: best.itemId, kind: 'corrected' };
}
