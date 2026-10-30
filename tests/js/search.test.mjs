// Unit tests for the browser-side search, suggestions and Quick Add parser.
// Run: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, editDistance, words } from '../../web/js/text.js';
import { parseSlot, canonicalSlot, compareSlots } from '../../web/js/slots.js';
import { parseQuery, indexItem, search, similarItems, highlight, hasTag } from '../../web/js/search.js';
import { parseQuickAdd, tokenAt } from '../../web/js/quickadd.js';

const item = (name, extra = {}) => ({
  id: name, name, description: '', notes: '', quantity: null, slots: [], tags: [], aliases: [], ...extra,
});

const items = [
  item('Condensateur céramique 100nF', { slots: ['A-12'], tags: ['electronic/passive/capacitor'], aliases: ['condo', 'decoupling cap'] }),
  item('Condensateur chimique 10µF', { slots: ['A-13'], tags: ['electronic/passive/capacitor'] }),
  item('ESP32-WROOM', { slots: ['B-2'], tags: ['electronic/mcu'], aliases: ['esp', 'wifi board'], quantity: 0 }),
  item('Scratch adhésif noir', { slots: ['C-3'], tags: ['fixing'], aliases: ['velcro', 'hook and loop'] }),
  item('Vis M3x10', { slots: ['C-1', 'C-2'], tags: ['hardware/screw'], description: 'Tête cylindrique, inox' }),
  item('Fer à souder', { tags: ['tool'] }),
];
const index = items.map(indexItem);
const names = (q) => search(index, q).hits.map((h) => h.item.name);

test('text helpers', () => {
  assert.equal(normalize('  Résistance   10K '), 'resistance 10k');
  assert.deepEqual(words('Vis M3x10, 3.3V / 100nF'), ['vis', 'm3x10', '3.3v', '100nf']);
  assert.equal(editDistance('condo', 'cnodo'), 1);
  assert.equal(editDistance('kitten', 'sitting', 1), 2);
});

test('slots', () => {
  assert.deepEqual(parseSlot('a12'), { box: 'A', number: 12 });
  assert.equal(canonicalSlot(' b2 - 03 '), 'B2-3');
  assert.equal(parseSlot('12'), null);
  assert.equal(parseSlot('A-0'), null);
  assert.deepEqual(['A-10', 'B-1', 'A-2'].sort(compareSlots), ['A-2', 'A-10', 'B-1']);
});

test('query parsing', () => {
  const q = parseQuery('cond #Electronic @a -smd is:out A-12 -5');
  assert.deepEqual(q.terms, ['cond', 'a-12', '-5']);
  assert.deepEqual(q.tags, ['electronic']);
  assert.deepEqual(q.boxes, ['A']);
  assert.deepEqual(q.excluded, ['smd']);
  assert.deepEqual(q.flags, ['out']);
  assert.equal(q.slot, 'A-12');
});

test('search by name, prefix, alias, typo and fzf-style', () => {
  assert.deepEqual(names('cond'), ['Condensateur céramique 100nF', 'Condensateur chimique 10µF']);
  assert.equal(names('100nf')[0], 'Condensateur céramique 100nF');
  assert.equal(names('velcro')[0], 'Scratch adhésif noir');        // alias
  assert.equal(names('hook loop')[0], 'Scratch adhésif noir');     // multi-word alias
  assert.equal(names('condesateur')[0].startsWith('Condensateur'), true); // typo
  assert.equal(names('scrtch')[0], 'Scratch adhésif noir');        // missing letter
  assert.equal(names('ceramique')[0], 'Condensateur céramique 100nF'); // accents
  assert.equal(names('esp')[0], 'ESP32-WROOM');
  assert.equal(names('inox')[0], 'Vis M3x10');                     // description
  assert.deepEqual(names('m3'), ['Vis M3x10']);                    // "M3" is not a slot here
  assert.deepEqual(names('zzzz'), []);
});

test('filters', () => {
  assert.deepEqual(names('#electronic'), ['Condensateur céramique 100nF', 'Condensateur chimique 10µF', 'ESP32-WROOM']);
  assert.deepEqual(names('#mcu'), ['ESP32-WROOM']);               // sub-tag segment
  assert.deepEqual(names('#capacitor -chimique'), ['Condensateur céramique 100nF']);
  assert.deepEqual(names('@C'), ['Vis M3x10', 'Scratch adhésif noir']);
  assert.deepEqual(names('is:out'), ['ESP32-WROOM']);
  assert.deepEqual(names('is:unplaced'), ['Fer à souder']);
  assert.ok(hasTag(items[0], 'electronic/passive'));
});

test('a slot lists its contents first', () => {
  const r = search(index, 'a13');
  assert.equal(r.slot, 'A-13');
  assert.deepEqual(r.hits.map((h) => [h.item.name, h.inSlot]), [['Condensateur chimique 10µF', true]]);
  assert.deepEqual(names('c-2'), ['Vis M3x10']);
});

test('empty query lists everything in slot order', () => {
  assert.deepEqual(names(''), [
    'Condensateur céramique 100nF', 'Condensateur chimique 10µF', 'ESP32-WROOM',
    'Vis M3x10', 'Scratch adhésif noir', 'Fer à souder',
  ]);
});

test('similar items catch duplicates and typos before adding', () => {
  const top = (name) => similarItems(index, name)[0];
  assert.equal(top('esp32-wroom').exact, true);
  assert.equal(top('ESP32 WROM').item.name, 'ESP32-WROOM');
  assert.equal(top('Condensateur ceramique 100 nF').item.name, 'Condensateur céramique 100nF');
  assert.equal(top('Scrath adhesif').item.name, 'Scratch adhésif noir');
  assert.equal(top('Velcro noir').item.name, 'Scratch adhésif noir');
  assert.equal(top('Velcro').matched, 'velcro');
  assert.equal(top('Fer a souder').exact, true);
  assert.equal(top('ESP32 clone').item.name, 'ESP32-WROOM');
  assert.equal(similarItems(index, 'Multimètre').length, 0);
  assert.equal(similarItems(index, 'Pince à dénuder').length, 0);
  assert.equal(similarItems(index, 'x').length, 0);
});

test('highlight', () => {
  const { chars, marks } = highlight('Condensateur céramique', ['cera']);
  assert.equal(chars.filter((_, i) => marks[i]).join(''), 'céra');
  const fz = highlight('Scratch adhésif', ['scrtch']);
  assert.equal(fz.chars.filter((_, i) => fz.marks[i]).join(''), 'Scrtch');
});

test('quick add', () => {
  const p = parseQuickAdd('ESP32-WROOM a-12 #Electronic/MCU ~esp ~"wifi board" x25 B-3');
  assert.equal(p.name, 'ESP32-WROOM');
  assert.deepEqual(p.slots, ['A-12', 'B-3']);
  assert.deepEqual(p.tags, ['electronic/mcu']);
  assert.deepEqual(p.aliases, ['esp', 'wifi board']);
  assert.equal(p.quantity, 25);
  assert.equal(parseQuickAdd('Vis M3x10 x').quantity, null);   // "M3x10" and a lone "x" are names
  assert.equal(parseQuickAdd('Vis M3x10 x').name, 'Vis M3x10 x');

  // Without a dash, a slot needs a known box: "M3" and "LM317" stay names.
  assert.equal(parseQuickAdd('Vis M3 LM317 C3').name, 'Vis M3 LM317 C3');
  const known = parseQuickAdd('Vis M3 C3', { knownBoxes: new Set(['C']) });
  assert.equal(known.name, 'Vis M3');
  assert.deepEqual(known.slots, ['C-3']);
  assert.deepEqual(parseQuickAdd('Fer @a7').slots, ['A-7']);
});

test('completion context', () => {
  assert.deepEqual(tokenAt('ESP #ele', 8), { type: 'tag', start: 4, end: 8, value: 'ele' });
  assert.equal(tokenAt('ESP a-', 6).type, 'slot');
  assert.equal(tokenAt('ESP a-1', 7).value, 'A-1');
  assert.equal(tokenAt('ESP wro', 7).type, 'name');
  assert.equal(tokenAt('ESP x12', 7).type, 'quantity');
  assert.equal(tokenAt('ESP ~wi', 7).type, 'alias');
});
