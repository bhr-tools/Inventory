// Text helpers shared by search, suggestions and parsing. Pure functions,
// tested under Node (tests/js).

/** Lowercase, without accents, single-spaced: "Résistance  10K" → "resistance 10k". */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits normalized text into words, keeping values like "10k", "m3" or "3.3v" whole. */
export function words(text) {
  return normalize(text).split(/[^\p{L}\p{N}.+µ]+/u).map((w) => w.replace(/^\.+|\.+$/g, '')).filter(Boolean);
}

/**
 * Damerau-Levenshtein distance (with adjacent transpositions), giving up once
 * it exceeds max: returns max + 1 in that case.
 */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

/** How many typos a word of this length tolerates. */
export function typoBudget(length) {
  if (length < 4) return 0;
  if (length < 7) return 1;
  return 2;
}

function trigrams(text) {
  const padded = `  ${text} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
}

/** Dice coefficient of the trigrams of two normalized strings, from 0 to 1. */
export function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });

/** A price in cents as "12,50 €" (in the browser's language). */
export function formatPrice(cents) {
  return money.format(cents / 100);
}

/**
 * Reads "12.50", "12,5", "1 299" or "12 €" as cents; empty is 0 (no price),
 * and anything else NaN.
 */
export function parsePrice(text) {
  const t = String(text ?? '').replace(/[\s\u00a0\u202f€]/g, '').replace(',', '.');
  if (!t) return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
