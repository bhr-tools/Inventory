// Slots are always chosen on a map of a box, never typed: the item form draws
// one inline, and moving a part opens one (tap a free slot to move it there,
// a used one to swap the two slots, then confirm). Boxes are created in the
// Boxes view (b), so a map only offers boxes that exist.

import { h } from '../dom.js';
import { openModal, toast } from '../ui/overlay.js';
import { parseSlot, slotName } from '../slots.js';

/** Every box: the configured ones and those only used by slots, sorted. */
export function boxIds(app) {
  const ids = new Set(app.boxes.map((b) => b.id));
  for (const s of app.slotMap.keys()) {
    const box = parseSlot(s)?.box;
    if (box) ids.add(box);
  }
  return [...ids].sort();
}

function usedNumbers(app, box) {
  return [...app.slotMap.keys()].map(parseSlot).filter((s) => s?.box === box).map((s) => s.number);
}

/**
 * Number of slots drawn for a box: its size when set; otherwise the used
 * ones plus one free slot after them.
 */
export function boxSize(app, box) {
  const config = app.boxes.find((b) => b.id === box);
  const used = usedNumbers(app, box);
  if (config?.slots) return Math.max(config.slots, ...used);
  return Math.max(0, ...used) + 1;
}

/** Free slots of a box, in order. */
export function freeSlots(app, box) {
  const out = [];
  for (let n = 1; n <= boxSize(app, box); n++) {
    const s = slotName({ box, number: n });
    if (!app.slotMap.has(s)) out.push(s);
  }
  return out;
}

/**
 * The slots of a box as a grid of buttons. chosen: slots drawn filled; self:
 * the item being edited or moved (its own slots do not count as taken).
 */
export function boxMap(app, box, { chosen = [], self = null, onTap }) {
  const cells = [];
  for (let n = 1; n <= boxSize(app, box); n++) {
    const s = slotName({ box, number: n });
    const items = (app.slotMap.get(s) || []).filter((it) => it.id !== self?.id);
    const names = items.map((it) => it.name).join(', ');
    cells.push(h('button', {
      type: 'button',
      class: ['map-cell', !items.length && 'free', chosen.includes(s) && 'self'],
      title: `${s}: ${names || 'free'}`,
      attrs: { 'aria-label': `${s}: ${names || 'free'}`, 'aria-pressed': String(chosen.includes(s)) },
      onclick: () => onTap(s, items),
    }, h('b', null, s), h('small', null, names)));
  }
  const map = h('div', { class: 'map' }, cells);
  // A box without a set size keeps 6 columns, so its few slots stay small.
  const columns = app.boxes.find((b) => b.id === box)?.columns || 6;
  map.style.setProperty('--columns', String(columns));
  return map;
}

/** Box buttons: Box A, Box B… */
export function boxTabs(app, current, onPick) {
  return h('div', { class: 'map-boxes', attrs: { role: 'group', 'aria-label': 'Box' } },
    boxIds(app).map((b) => h('button', {
      type: 'button',
      class: ['map-box', b === current && 'active'],
      attrs: { 'aria-pressed': String(b === current) },
      onclick: () => onPick(b),
    }, `Box ${b}`)));
}

/**
 * With item: moves or swaps it, and resolves once done. With items (several):
 * resolves to the free slot tapped, where they are moved. Without either:
 * resolves to the free slot tapped, or null.
 */
export function openSlotMap(app, { item = null, items = null, box = null } = {}) {
  return new Promise((resolve) => {
    if (!boxIds(app).length) {
      toast('No box yet: create one in Boxes (b, or the ⋯ menu)', { type: 'error' });
      return resolve(null);
    }
    const from = item?.slots[0] || null;
    let current = box || (from && parseSlot(from)?.box) || boxIds(app)[0];
    let chosen = null;
    let answer = null;
    const body = h('div', { class: 'grid-view' });

    function render() {
      body.replaceChildren(
        boxTabs(app, current, (b) => {
          current = b;
          chosen = null;
          render();
        }),
        boxMap(app, current, { chosen: [chosen, from].filter(Boolean), self: item, onTap: tap }),
        h('p', { class: 'map-legend' }, item
          ? 'dashed = free · tap a free slot to move, a used one to swap'
          : 'dashed = free · tap a free slot'),
        ...[confirmation()].filter(Boolean));
    }

    function tap(s, others) {
      if (item) {
        chosen = s === from ? null : s;
        render();
        body.querySelector('.map-confirm')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      if (others.length) return toast(`${s} holds ${others[0].name}`);
      answer = s;
      modal.close();
    }

    function confirmation() {
      if (!item || !chosen) return null;
      const others = app.slotMap.get(chosen) || [];
      const slot = (s) => h('b', { class: 'slot' }, s);
      if (others.length && from) {
        return h('div', { class: 'map-confirm' },
          h('p', null, 'Swap ', slot(from), ` ${item.name} with `, slot(chosen), ` ${others.map((o) => o.name).join(', ')}?`),
          h('button', { type: 'button', class: 'button primary wide', onclick: () => run(() => app.swapSlots(from, chosen)) }, 'Swap slots'));
      }
      return h('div', { class: 'map-confirm' },
        h('p', null, `Move ${item.name}`, from ? [' from ', slot(from)] : null, ' to ', slot(chosen), '?'),
        h('button', {
          type: 'button',
          class: 'button primary wide',
          // A part in several slots only leaves the one shown.
          onclick: () => run(() => (item.slots.length > 1 ? app.replaceSlot(item, from, chosen) : app.moveTo([item], chosen))),
        }, 'Move here'));
    }

    async function run(change) {
      modal.close();
      await change();
    }

    const title = item
      ? `Move · ${from || item.name}`
      : items ? `Move ${items.length} items to…` : 'Pick a slot';
    const modal = openModal({
      title,
      back: '← Back',
      className: 'map-modal',
      body,
      autofocus: false,
      onClose: () => resolve(answer),
    });
    render();
  });
}
