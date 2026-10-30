// Quick Add syntax, parsed as you type:
//   ESP32-WROOM A-12 #electronic/mcu ~esp ~"wifi board" x5
// A-12 is a slot (several allowed), #tag a tag, ~alias an alias (quote it to
// include spaces), x5 the quantity. Everything else is the name.
// Tools have no slot and no count; they take instead
//   Drill brand:Makita ref:DHP482 sn:"A1 2" until:2027-03 #power
// where until: is the warranty end (2027, 2027-03 or 2027-03-31).
// A slot needs its dash ("A-12") unless its box already exists, so that names
// like "M3 screw" or "LM317" stay names.
// Pure functions, tested under Node (tests/js).

import { parseSlot, slotName } from './slots.js';

const QUANTITY = /^[x×](\d{1,7})$/i;
const TOOL_FIELDS = { 'brand:': 'brand', 'ref:': 'model', 'sn:': 'serial', 'until:': 'warranty' };
const TOOL_FIELD = /^(brand:|ref:|sn:|until:)(.*)$/i;

/** Splits text into tokens with their positions; ~"quoted" and key:"quoted" values are one token. */
export function tokenize(text) {
  const tokens = [];
  const re = /(?:~|[a-z]+:)"[^"]*"?|\S+/gi;
  let m;
  while ((m = re.exec(text))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return tokens;
}

/**
 * The kind of a token: 'slot', 'tag', 'alias', 'quantity' or 'name'; for a
 * tool, 'brand', 'model', 'serial' or 'warranty' instead of slot and quantity.
 */
export function tokenType(token, knownBoxes = new Set(), kind = 'part') {
  if (token.length > 1 && token.startsWith('#')) return 'tag';
  if (token.length > 1 && token.startsWith('~')) return 'alias';
  if (kind === 'tool') {
    const m = TOOL_FIELD.exec(token);
    return m ? TOOL_FIELDS[m[1].toLowerCase()] : 'name';
  }
  if (QUANTITY.test(token)) return 'quantity';
  const bare = token.startsWith('@') ? token.slice(1) : token;
  const slot = parseSlot(bare);
  if (slot && (token.startsWith('@') || bare.includes('-') || knownBoxes.has(slot.box))) return 'slot';
  return 'name';
}

/**
 * Parses a Quick Add line into { name, slots, tags, aliases, quantity, tokens },
 * where tokens carry their type for highlighting.
 */
export function parseQuickAdd(text, { knownBoxes = new Set(), kind = 'part' } = {}) {
  const out = {
    name: '', slots: [], tags: [], aliases: [], quantity: null, tokens: [],
    brand: '', model: '', serial: '', warranty: '', warrantyError: false,
  };
  const nameParts = [];
  for (const tok of tokenize(text)) {
    const type = tokenType(tok.text, knownBoxes, kind);
    out.tokens.push({ ...tok, type });
    switch (type) {
      case 'slot': {
        const s = slotName(parseSlot(tok.text.replace(/^@/, '')));
        if (!out.slots.includes(s)) out.slots.push(s);
        break;
      }
      case 'tag': {
        const t = tok.text.slice(1).toLowerCase();
        if (!out.tags.includes(t)) out.tags.push(t);
        break;
      }
      case 'alias': {
        const a = tok.text.slice(1).replace(/^"|"$/g, '').trim();
        if (a && !out.aliases.includes(a)) out.aliases.push(a);
        break;
      }
      case 'quantity':
        out.quantity = Number(QUANTITY.exec(tok.text)[1]);
        break;
      case 'brand': case 'model': case 'serial': {
        out[type] = TOOL_FIELD.exec(tok.text)[2].replace(/^"|"$/g, '').trim();
        break;
      }
      case 'warranty': {
        const raw = TOOL_FIELD.exec(tok.text)[2];
        out.warranty = warrantyDate(raw) || '';
        out.warrantyError = Boolean(raw) && !out.warranty;
        break;
      }
      default:
        nameParts.push(tok.text);
    }
  }
  out.name = nameParts.join(' ');
  return out;
}

/**
 * The token under the caret, for completion: { type, start, end, value }
 * where value is the text typed so far without its prefix. type is 'tag',
 * 'alias', 'slot' (a box id followed by a dash, or a slot), 'quantity' or 'name'.
 */
export function tokenAt(text, caret, { knownBoxes = new Set(), kind = 'part' } = {}) {
  const tok = tokenize(text).find((t) => t.start <= caret && caret <= t.end);
  if (!tok) return { type: 'name', start: caret, end: caret, value: '' };
  const t = tok.text;
  if (t.startsWith('#')) return { type: 'tag', start: tok.start, end: tok.end, value: t.slice(1) };
  if (t.startsWith('~')) return { type: 'alias', start: tok.start, end: tok.end, value: t.slice(1) };
  if (kind === 'tool') {
    const m = TOOL_FIELD.exec(t);
    return m
      ? { type: TOOL_FIELDS[m[1].toLowerCase()], start: tok.start, end: tok.end, value: m[2] }
      : { type: 'name', start: tok.start, end: tok.end, value: t };
  }
  if (QUANTITY.test(t)) return { type: 'quantity', start: tok.start, end: tok.end, value: t.slice(1) };
  const bare = t.replace(/^@/, '');
  if (t.startsWith('@') || /^[A-Za-z][A-Za-z0-9]*-\d*$/.test(bare) || tokenType(t, knownBoxes) === 'slot') {
    return { type: 'slot', start: tok.start, end: tok.end, value: bare.toUpperCase() };
  }
  return { type: 'name', start: tok.start, end: tok.end, value: t };
}

/**
 * A warranty end from "2027", "2027-03" or "2027-03-31": the last day of the
 * year or month when it is not given. Returns YYYY-MM-DD, or null.
 */
export function warrantyDate(text) {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(String(text).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 12;
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = m[3] ? Number(m[3]) : last;
  if (day < 1 || day > last) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
