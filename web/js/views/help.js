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
    [['a'], 'Add parts'],
    [['+', '-'], 'One more / one less'],
    [['x'], 'Type the quantity'],
    [['m'], 'Move to a slot'],
    [['s'], 'Swap two slots'],
    [['t'], 'Add or remove tags'],
    [['d'], 'Delete'],
    [['u'], 'Undo'],
  ]],
  ['Views', [
    [['1', '2'], 'Inventory / Shopping list (& é on AZERTY)'],
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
];

const ADD = [
  ['A-12', 'slot (several allowed); A12 works once box A exists'],
  ['#tag', 'tag, #parent/child for a sub-tag'],
  ['~alias  ~"two words"', 'another name to find it by'],
  ['x5', 'quantity (default 0)'],
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
      h('h3', null, 'Add syntax'),
      h('div', { class: 'help-syntax' }, table(ADD)),
    ],
  });
}
