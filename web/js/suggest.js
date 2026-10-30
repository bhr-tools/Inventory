// Suggestions shared by every field that takes tags or slots.

import { normalize } from './text.js';
import { parseSlot, slotName, isBoxId } from './slots.js';

/** The whitespace-separated token under the caret of a field: { start, end, text }. */
export function tokenUnderCaret(input) {
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Existing tags matching what was typed, most used first. range is the part
 * of the field to replace, prefix what to write before the tag ("#" in Quick
 * Add, "" or "-" in tag fields).
 */
export function tagSuggestions(app, typed, range, { prefix = '', exclude = [] } = {}) {
  const v = normalize(typed);
  const out = [];
  for (const [tag, count] of app.tagCounts) {
    if (exclude.includes(tag)) continue;
    let rank;
    if (!v) rank = 2;
    else if (tag.startsWith(v)) rank = 0;
    else if (tag.split('/').some((seg) => seg.startsWith(v))) rank = 1;
    else if (v.length >= 3 && tag.includes(v)) rank = 2;
    else continue;
    out.push({ tag, count, rank });
  }
  out.sort((a, b) => (a.rank - b.rank) || (b.count - a.count) || a.tag.localeCompare(b.tag));
  return out.slice(0, 8).map(({ tag, count }) => ({
    label: `${prefix}${tag}`,
    hint: `${count} item${count === 1 ? '' : 's'}`,
    insert: { ...range, text: `${prefix}${tag} ` },
  }));
}

/** What a slot holds, in a few words. */
export function slotSummary(app, slot) {
  const items = app.slotMap.get(slot) || [];
  if (!items.length) return 'empty';
  const names = items.slice(0, 2).map((it) => it.name).join(', ');
  return items.length > 2 ? `${names} +${items.length - 2}` : names;
}

/**
 * Slots of the box being typed ("A-", "A-1", "a1"), free ones first while no
 * number is typed. A configured box lists all its slots; another box lists the
 * used ones plus the next free number.
 */
export function slotSuggestions(app, typed, range, { prefix = '' } = {}) {
  const t = typed.trim().toUpperCase();
  let box;
  let digits = '';
  const m = /^([A-Z][A-Z0-9]*)-(\d*)$/.exec(t);
  const full = parseSlot(t);
  if (m) [, box, digits] = m;
  else if (full) [box, digits] = [full.box, String(full.number)];
  else if (isBoxId(t) && app.knownBoxes.has(t)) box = t;
  else return [];

  const config = app.boxes.find((b) => b.id === box);
  const used = [...app.slotMap.keys()].map(parseSlot).filter((s) => s && s.box === box).map((s) => s.number);
  let numbers;
  if (config?.slots) numbers = Array.from({ length: config.slots }, (_, i) => i + 1);
  else numbers = [...new Set([...used, used.length ? Math.max(...used) + 1 : 1])];
  for (const n of used) if (!numbers.includes(n)) numbers.push(n);
  numbers.sort((a, b) => a - b);

  let candidates = numbers.filter((n) => String(n).startsWith(digits));
  if (!digits) {
    const free = candidates.filter((n) => !app.slotMap.has(slotName({ box, number: n })));
    candidates = [...free, ...candidates.filter((n) => !free.includes(n))];
  } else if (!candidates.length && Number(digits) > 0) {
    candidates = [Number(digits)];
  }
  return candidates.slice(0, 8).map((n) => {
    const slot = slotName({ box, number: n });
    const summary = slotSummary(app, slot);
    return {
      label: `${prefix}${slot}`,
      hint: summary,
      className: summary === 'empty' ? 'is-free' : '',
      insert: { ...range, text: `${prefix}${slot} ` },
    };
  });
}
