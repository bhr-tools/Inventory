// Keyboard shortcuts and search syntax cheatsheet.

import { h } from '../dom.js';
import { openModal } from '../ui/overlay.js';

const SECTIONS = [
  ['Search', [
    [['/'], 'Search (from anywhere)'],
    [['↓', '↑'], 'Move while typing (or Ctrl+J/K)'],
    [['Enter'], 'Leave the search, keep the results'],
    [['Esc'], 'Leave the search; again clears it'],
  ]],
  ['Results', [
    [['j', 'k'], 'Next / previous'],
    [['gg', 'G'], 'First / last'],
    [['Enter', 'e'], 'Edit the item'],
    [['Space'], 'Select (then act on the selection)'],
    [['a'], 'Add an item (the same form as edit)'],
    [['+', '-'], 'One more / one less'],
    [['x'], 'Type the quantity'],
    [['f'], 'Attach files (or drop them on the details)'],
    [['o'], 'Open the first file'],
    [['m'], 'Move, on the map of the box'],
    [['s'], 'Swap: tap a used slot on the map'],
    [['t'], 'Add or remove tags'],
    [['A'], 'Archive gear (broken, lost, sold), or restore it'],
    [['d'], 'Delete'],
    [['u'], 'Undo'],
  ]],
  ['Views', [
    [['1', '2', '3'], 'Parts / gear / to buy (& é " on AZERTY)'],
    [['b'], 'Boxes, as grids'],
    [['T'], 'Tags'],
    [['?'], 'This help'],
  ]],
  ['Box grid', [
    [['h', 'j', 'k', 'l'], 'Move'],
    [['[', ']'], 'Previous / next box'],
    [['Enter'], 'Show the slot'],
    [['a'], 'Add to the slot'],
    [['s'], 'Swap: on the first slot, then the second'],
    [['D'], 'Delete the box (only when empty)'],
  ]],
];

const SYNTAX = [
  ['cond 100nf', 'words, typos forgiven (condesateur works)'],
  ['A-12', 'what is in a slot'],
  ['#electronic', 'a tag and its sub-tags (#mcu finds electronic/mcu)'],
  ['@A', 'only box A'],
  ['-smd', 'without “smd”'],
  ['is:out  is:tobuy', 'quantity 0, or on the shopping list'],
  ['is:empty', 'free slots of the configured boxes'],
  ['is:untagged  is:unplaced', 'items without tags, or without a slot'],
  ['makita  sn12345', 'gear by brand, reference or serial (from its start)'],
  ['type:watch', 'gear of one type (is:tool for type:tool)'],
  ['is:archived', 'archived gear (broken, lost, sold), hidden from the list'],
  ['is:warranty  has:file', 'still under warranty; with attachments'],
];


export function openHelp() {
  const keys = (list) => h('span', { class: 'help-keys' }, list.map((k) => h('kbd', null, k)));
  const table = (rows) => rows.map(([code, text]) => h('div', { class: 'help-row' }, h('code', null, code), h('span', null, text)));
  openModal({
    title: 'Keyboard shortcuts',
    className: 'help',
    autofocus: false,
    body: [
      h('div', { class: 'help-grid' }, SECTIONS.map(([title, rows]) => h('div', null,
        h('h3', null, title),
        rows.map(([k, text]) => h('div', { class: 'help-row' }, h('span', null, text), keys(k)))))),
      h('h3', null, 'Search syntax'),
      h('div', { class: 'help-syntax' }, table(SYNTAX)),
    ],
  });
}
