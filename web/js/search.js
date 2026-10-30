// Inventory search, run in the browser on every keystroke.
//
// A query mixes free words and filters:
//   cond 100nF        words, all required, matched fuzzily (prefix, typo, fzf)
//   #electronic       tag, including its sub-tags; #mcu also finds electronic/mcu
//   @A                box A
//   -smd              exclude items mentioning "smd"
//   is:low is:out     stock level; is:untagged, is:unplaced
//   A-12              a slot: its contents come first
// Pure functions, tested under Node (tests/js).

import { normalize, words, editDistance, typoBudget, similarity } from './text.js';
import { parseSlot, slotName, compareSlots } from './slots.js';

const FLAGS = new Set(['low', 'out', 'plenty', 'untagged', 'unplaced', 'empty']);

// How much a match in each field counts.
const WEIGHTS = { name: 1, alias: 0.9, tag: 0.7, description: 0.45, notes: 0.35 };

export function parseQuery(query) {
  const q = { terms: [], excluded: [], tags: [], boxes: [], flags: [], slot: null, raw: query };
  for (const token of String(query ?? '').trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (token.length > 1 && token.startsWith('#')) q.tags.push(normalize(token.slice(1)));
    else if (token.length > 1 && token.startsWith('@')) q.boxes.push(token.slice(1).toUpperCase());
    else if (token.length > 1 && token.startsWith('-') && !/^-\d/.test(token)) q.excluded.push(normalize(token.slice(1)));
    else if (lower.startsWith('is:') && FLAGS.has(lower.slice(3))) q.flags.push(lower.slice(3));
    else {
      const slot = parseSlot(token);
      if (slot && !q.slot) q.slot = slotName(slot);
      q.terms.push(normalize(token));
    }
  }
  return q;
}

/** Precomputes the normalized text of an item, once per inventory load. */
export function indexItem(item) {
  const field = (text) => ({ text: normalize(text), words: words(text) });
  return {
    item,
    name: field(item.name),
    aliases: (item.aliases || []).map(field),
    tags: (item.tags || []).map((t) => ({ text: normalize(t), words: words(t.replace(/\//g, ' ')) })),
    description: field(item.description),
    notes: field(item.notes),
  };
}

/** Score in [0, 1] of one query term against one field. */
export function termScore(term, field, { fuzzy = true } = {}) {
  if (!term || !field.text) return 0;
  if (field.text === term) return 1;
  let best = 0;
  const budget = typoBudget(term.length);
  for (const w of field.words) {
    if (w === term) return 0.95;
    if (w.startsWith(term)) best = Math.max(best, 0.85);
    else if (fuzzy && budget > 0 && best < 0.6) {
      const full = editDistance(term, w, budget);
      if (full <= budget) best = Math.max(best, 0.62 - 0.08 * full);
      // A word being typed with a typo: "condes" for "condensateur".
      if (w.length > term.length) {
        const prefix = editDistance(term, w.slice(0, term.length), budget);
        if (prefix <= budget) best = Math.max(best, 0.55 - 0.08 * prefix);
      }
    }
  }
  if (best < 0.7 && field.text.includes(term)) best = 0.7;
  if (fuzzy && best < 0.3 && term.length >= 2) {
    const span = subsequenceSpan(term, field.text);
    if (span) best = Math.max(best, 0.4 * (term.length / span));
  }
  return best;
}

/** Length of the shortest stretch of text containing the letters of term in order, or 0. */
function subsequenceSpan(term, text) {
  let best = 0;
  for (let start = text.indexOf(term[0]); start !== -1; start = text.indexOf(term[0], start + 1)) {
    let i = 1;
    let j = start + 1;
    while (i < term.length && j < text.length) {
      if (text[j] === term[i]) i++;
      j++;
    }
    if (i < term.length) break;
    const span = j - start;
    if (!best || span < best) best = span;
  }
  // Letters scattered too far apart are noise, not a match.
  return best && best <= term.length * 3 ? best : 0;
}

/** Best weighted score of a term over every field of an indexed item. */
function bestFieldScore(term, idx) {
  let best = WEIGHTS.name * termScore(term, idx.name);
  for (const a of idx.aliases) best = Math.max(best, WEIGHTS.alias * termScore(term, a));
  for (const t of idx.tags) best = Math.max(best, WEIGHTS.tag * termScore(term, t));
  if (best < 0.9) {
    best = Math.max(best, WEIGHTS.description * termScore(term, idx.description, { fuzzy: false }));
    best = Math.max(best, WEIGHTS.notes * termScore(term, idx.notes, { fuzzy: false }));
  }
  return best;
}

function mentions(idx, word) {
  return [idx.name, ...idx.aliases, ...idx.tags, idx.description, idx.notes].some((f) => f.text.includes(word));
}

/** True when the item has the tag, one of its sub-tags, or a tag segment starting with it. */
export function hasTag(item, wanted) {
  return (item.tags || []).some((tag) => {
    const t = normalize(tag);
    return t === wanted || t.startsWith(wanted) || t.split('/').some((seg) => seg.startsWith(wanted));
  });
}

function passesFilters(idx, q) {
  const it = idx.item;
  if (q.tags.some((t) => !hasTag(it, t))) return false;
  if (q.boxes.length && !it.slots.some((s) => q.boxes.includes(parseSlot(s)?.box))) return false;
  if (q.excluded.some((w) => mentions(idx, w))) return false;
  for (const f of q.flags) {
    if ((f === 'low' || f === 'out' || f === 'plenty') && it.stock !== f) return false;
    if (f === 'untagged' && it.tags.length) return false;
    if (f === 'unplaced' && it.slots.length) return false;
  }
  return true;
}

/**
 * Searches indexed items. Returns { slot, hits }, where hits are
 * { item, score, inSlot } ordered best first. Without words, every item
 * passing the filters is returned in slot order.
 */
export function search(index, query) {
  const q = typeof query === 'string' ? parseQuery(query) : query;
  const hits = [];
  for (const idx of index) {
    if (!passesFilters(idx, q)) continue;
    const inSlot = !!q.slot && idx.item.slots.includes(q.slot);
    let score = 0;
    let ok = true;
    for (const term of q.terms) {
      // The slot token is satisfied by being in that slot.
      if (inSlot && parseSlot(term) && slotName(parseSlot(term)) === q.slot) {
        score += 1;
        continue;
      }
      const s = bestFieldScore(term, idx);
      if (s < 0.2) {
        ok = false;
        break;
      }
      score += s;
    }
    if (ok) hits.push({ item: idx.item, score, inSlot });
  }
  if (q.terms.length) {
    hits.sort((a, b) => (b.inSlot - a.inSlot) || (b.score - a.score) || byName(a.item, b.item));
  } else {
    hits.sort((a, b) => bySlot(a.item, b.item));
  }
  return { slot: q.slot, hits };
}

function byName(a, b) {
  return normalize(a.name).localeCompare(normalize(b.name));
}

function bySlot(a, b) {
  if (!a.slots.length || !b.slots.length) return (b.slots.length - a.slots.length) || byName(a, b);
  return compareSlots(a.slots[0], b.slots[0]) || byName(a, b);
}

/**
 * Existing items whose name or alias looks like `name`: what the user may be
 * about to add twice. Returns [{ item, score, exact, matched }] best first,
 * where matched is the name or alias that looked alike.
 */
export function similarItems(index, name, { limit = 5, threshold = 0.42 } = {}) {
  const n = normalize(name);
  if (n.length < 2) return [];
  const terms = words(name);
  const out = [];
  for (const idx of index) {
    let best = { score: 0, exact: false, matched: idx.item.name };
    for (const cand of [idx.name, ...idx.aliases]) {
      const original = cand === idx.name ? idx.item.name : idx.item.aliases[idx.aliases.indexOf(cand)];
      if (cand.text === n) {
        best = { score: 1, exact: true, matched: original };
        break;
      }
      let s = similarity(n, cand.text);
      if (cand.text.startsWith(n)) s = Math.max(s, 0.75 + 0.2 * (n.length / cand.text.length));
      if (terms.length) {
        const avg = terms.reduce((sum, t) => sum + termScore(t, cand), 0) / terms.length;
        s = Math.max(s, 0.85 * avg);
      }
      if (s > best.score) best = { score: s, exact: false, matched: original };
    }
    if (best.score >= threshold) out.push({ item: idx.item, ...best });
  }
  out.sort((a, b) => (b.score - a.score) || byName(a.item, b.item));
  return out.slice(0, limit);
}

/**
 * Which characters of `text` to highlight for the query words: a boolean per
 * character (by code point), for prefix, substring or fzf-style matches.
 */
export function highlight(text, terms) {
  const chars = [...String(text ?? '')];
  const folded = chars.map((c) => normalize(c) || ' ');
  // Map each position of the folded string back to its character.
  let joined = '';
  const owner = [];
  folded.forEach((f, i) => {
    for (const ch of f) {
      joined += ch;
      owner.push(i);
    }
  });
  const marks = new Array(chars.length).fill(false);
  for (const term of terms) {
    if (!term) continue;
    let at = joined.indexOf(term);
    if (at !== -1) {
      for (let k = at; k < at + term.length; k++) marks[owner[k]] = true;
      continue;
    }
    // fzf-style: the letters in order, picking the shortest stretch.
    let bestStart = -1;
    let bestEnd = Infinity;
    for (let s = joined.indexOf(term[0]); s !== -1; s = joined.indexOf(term[0], s + 1)) {
      let i = 1;
      let j = s + 1;
      while (i < term.length && j < joined.length) {
        if (joined[j] === term[i]) i++;
        j++;
      }
      if (i < term.length) break;
      if (j - s < bestEnd - bestStart) {
        bestStart = s;
        bestEnd = j;
      }
    }
    if (bestStart === -1 || bestEnd - bestStart > term.length * 3) continue;
    for (let i = 0, j = bestStart; i < term.length && j < bestEnd; j++) {
      if (joined[j] === term[i]) {
        marks[owner[j]] = true;
        i++;
      }
    }
  }
  return { chars, marks };
}
