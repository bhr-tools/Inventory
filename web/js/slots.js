// Slot references, written "A-12": the same rules as internal/db/normalize.go.

const WITH_SEPARATOR = /^([A-Z][A-Z0-9]*)\s*[-\s]\s*(\d+)$/;
const COMPACT = /^([A-Z]+)(\d+)$/;
const MAX_BOX_ID = 8;
const MAX_NUMBER = 9999;

/** Parses "A-12", "a12" or "B2-3" into { box, number }, or returns null. */
export function parseSlot(text) {
  const t = String(text ?? '').trim().toUpperCase();
  const m = WITH_SEPARATOR.exec(t) || COMPACT.exec(t);
  if (!m || m[1].length > MAX_BOX_ID) return null;
  const number = Number(m[2]);
  if (number < 1 || number > MAX_NUMBER) return null;
  return { box: m[1], number };
}

export function slotName(slot) {
  return `${slot.box}-${slot.number}`;
}

/** The canonical form of a slot reference ("a12" → "A-12"), or null. */
export function canonicalSlot(text) {
  const s = parseSlot(text);
  return s ? slotName(s) : null;
}

/** Orders slot names by box, then number (A-2 before A-10). */
export function compareSlots(a, b) {
  const sa = parseSlot(a);
  const sb = parseSlot(b);
  if (!sa || !sb) return String(a).localeCompare(String(b));
  if (sa.box !== sb.box) return sa.box < sb.box ? -1 : 1;
  return sa.number - sb.number;
}

/** True for a box id such as "A" or "B2". */
export function isBoxId(text) {
  const t = String(text ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*$/.test(t) && t.length <= MAX_BOX_ID;
}
