/**
 * The guarantee behind ⌘⇧D: restoring diacritics may add accents and nothing
 * else. Both texts are reduced to their bare letters and must match exactly,
 * so a model that also "fixes" spelling, grammar or wording is caught before
 * anything reaches the note.
 */

/** Letters that aren't a base letter plus a combining mark, so NFD can't
 *  take them apart — mapped to the letter typed in their place. */
const BARE: Record<string, string> = {
  ı: "i",
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ħ: "h",
  Ħ: "H",
  ß: "ss",
};

/** `text` with every accent removed: "Bağdemir" → "Bagdemir". */
export function accentSkeleton(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ıłŁøØđĐħĦß]/g, (c) => BARE[c]);
}

/** True when `after` differs from `before` by accents alone. */
export function onlyAccentsChanged(before: string, after: string): boolean {
  return accentSkeleton(before) === accentSkeleton(after);
}
