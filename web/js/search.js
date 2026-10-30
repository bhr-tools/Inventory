// Inventory search, run in the browser on every keystroke.
//
// A query mixes free words and filters:
//   cond 100nF        words, all required, matched fuzzily (prefix, typo, fzf)
//   #electronic       tag, including its sub-tags; #mcu also finds electronic/mcu
//   @A                box A
//   -smd              exclude items mentioning "smd"
//   is:out            quantity 0; is:tobuy  on the shopping list
//   is:untagged is:unplaced is:empty
//   is:tool is:part   one kind; is:archived  tools gone (broken, lost, sold)
//   is:warranty       tools still under warranty; has:file  with attachments
// Tools are also found by brand, reference and serial number (exact or prefix,
// never fuzzy: a serial one character off is another tool), and any item by
// the names of its attached files.
//   A-12              a slot: its contents come first
// Pure functions, tested under Node (tests/js).

import { normalize, words, editDistance, typoBudget, similarity } from './text.js';
import { parseSlot, slotName, compareSlots } from './slots.js';

const FLAGS = new Set(['out', 'tobuy', 'untagged', 'unplaced', 'empty', 'tool', 'part', 'archived', 'warranty']);

// How much a match in each field counts.
const WEIGHTS = { name: 1, serial: 1, model: 0.9, alias: 0.9, brand: 0.8, tag: 0.7, file: 0.5, description: 0.45, notes: 0.35 };

/** today (YYYY-MM-DD) decides is:warranty; tests pass a fixed one. */
export function parseQuery(query, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const q = { terms: [], excluded: [], tags: [], boxes: [], flags: [], slot: null, raw: query, today };
  for (const token of String(query ?? '').trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (token.length > 1 && token.startsWith('#')) q.tags.push(normalize(token.slice(1)));
    else if (token.length > 1 && token.startsWith('@')) q.boxes.push(token.slice(1).toUpperCase());
    else if (token.length > 1 && token.startsWith('-') && !/^-\d/.test(token)) q.excluded.push(normalize(token.slice(1)));
    else if (lower.startsWith('is:') && FLAGS.has(lower.slice(3))) q.flags.push(lower.slice(3));
    else if (lower === 'has:file' || lower === 'has:files') q.flags.push('file');
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
    brand: field(item.brand),
    model: field(item.model),
    serial: compact(item.serial),
    files: (item.attachments || []).map((a) => field(a.filename)),
  };
}

/** Serials compare without case, spaces or dashes: "SN 12-34" is "sn1234". */
function compact(text) {
  return normalize(text).replace(/[\s\-_./]/g, '');
}

function serialScore(term, serial) {
  if (!serial) return 0;
  const t = compact(term);
  if (t.length < 3) return 0;
  if (serial === t) return 1;
  return serial.startsWith(t) ? 0.9 : 0;
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
  if (idx.serial) best = Math.max(best, WEIGHTS.serial * serialScore(term, idx.serial));
  if (idx.model?.text) best = Math.max(best, WEIGHTS.model * termScore(term, idx.model));
  if (idx.brand?.text) best = Math.max(best, WEIGHTS.brand * termScore(term, idx.brand));
  for (const f of idx.files || []) best = Math.max(best, WEIGHTS.file * termScore(term, f, { fuzzy: false }));
  if (best < 0.9) {
    best = Math.max(best, WEIGHTS.description * termScore(term, idx.description, { fuzzy: false }));
    best = Math.max(best, WEIGHTS.notes * termScore(term, idx.notes, { fuzzy: false }));
  }
  return best;
}

function mentions(idx, word) {
  return [idx.name, ...idx.aliases, ...idx.tags, idx.description, idx.notes, idx.brand, idx.model, ...(idx.files || [])]
    .some((f) => f?.text.includes(word));
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
    if (f === 'out' && it.quantity !== 0) return false;
    if (f === 'tobuy' && !it.to_buy) return false;
    if (f === 'untagged' && it.tags.length) return false;
    if (f === 'unplaced' && it.slots.length) return false;
    if ((f === 'tool' || f === 'part') && (it.kind || 'part') !== f) return false;
    if (f === 'archived' && it.status !== 'archived') return false;
    if (f === 'warranty' && !(it.warranty_until && it.warranty_until >= q.today)) return false;
    if (f === 'file' && !(it.attachments || []).length) return false;
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
        const scores = terms.map((t) => termScore(t, cand));
        s = Math.max(s, 0.85 * (scores.reduce((a, b) => a + b, 0) / terms.length));
        // One distinctive word matching well is enough to ask: "ESP32 clone" → ESP32-WROOM.
        terms.forEach((t, i) => {
          if (t.length >= 4) s = Math.max(s, 0.6 * scores[i]);
        });
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
