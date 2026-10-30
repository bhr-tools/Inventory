// Phones: a box drawn as its slots. Moving a part: tap a free slot to move it
// there, or a used one to swap the two slots, then confirm. The add form also
// uses it to pick a free slot. (Desktop keeps the m and s dialogs and the b grid.)

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

/** Free slots of a box: all of them when its size is set, else the next number. */
export function freeSlots(app, box) {
  const config = app.boxes.find((b) => b.id === box);
  const used = new Set(usedNumbers(app, box));
  if (config?.slots) {
    const out = [];
    for (let n = 1; n <= config.slots; n++) if (!used.has(n)) out.push(slotName({ box, number: n }));
    return out;
  }
  return [slotName({ box, number: used.size ? Math.max(...used) + 1 : 1 })];
}

/**
 * With item: moves or swaps it, and resolves once done. Without: resolves to
 * the free slot tapped, or null.
 */
export function openSlotMap(app, { item = null, box = null, slot = null } = {}) {
  return new Promise((resolve) => {
    const from = item?.slots[0] || null;
    let current = box || (from && parseSlot(from)?.box) || boxIds(app)[0] || 'A';
    let chosen = item ? null : slot;
    let answer = null;
    const body = h('div', { class: 'grid-view' });

    const size = (b) => Math.max(app.boxes.find((x) => x.id === b)?.slots || 0, ...usedNumbers(app, b), 1);
    const columns = (b) => app.boxes.find((x) => x.id === b)?.columns || Math.min(6, size(b));

    function render() {
      const cells = [];
      for (let n = 1; n <= size(current); n++) {
        const s = slotName({ box: current, number: n });
        const items = app.slotMap.get(s) || [];
        const self = Boolean(item && items.some((it) => it.id === item.id));
        const names = items.map((it) => it.name).join(', ');
        cells.push(h('button', {
          type: 'button',
          class: ['map-cell', !items.length && 'free', self && 'self', chosen === s && 'chosen'],
          attrs: { 'aria-label': `${s}: ${names || 'free'}` },
          onclick: () => tap(s, items, self),
        }, h('b', null, s), h('small', null, names)));
      }
      const map = h('div', { class: 'map' }, cells);
      map.style.setProperty('--columns', String(columns(current)));
      const boxes = boxIds(app);
      body.replaceChildren(
        h('div', { class: 'map-boxes', attrs: { role: 'group', 'aria-label': 'Box' } },
          (boxes.length ? boxes : [current]).map((b) => h('button', {
            type: 'button',
            class: ['map-box', b === current && 'active'],
            onclick: () => {
              current = b;
              if (item) chosen = null;
              render();
            },
          }, `Box ${b}`))),
        map,
        h('p', { class: 'map-legend' }, item
          ? 'dashed = free · tap a free slot to move, a used one to swap'
          : 'dashed = free · tap a free slot'),
        confirmation());
    }

    function tap(s, items, self) {
      if (self) {
        chosen = null;
        return render();
      }
      if (!item) {
        if (items.length) return toast(`${s} holds ${items[0].name}`);
        answer = s;
        return modal.close();
      }
      chosen = s;
      render();
      body.querySelector('.map-confirm')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

    const modal = openModal({
      title: item ? `Move · ${from || item.name}` : 'Pick a slot',
      back: '← Back',
      className: 'map-modal',
      body,
      autofocus: false,
      onClose: () => resolve(answer),
    });
    render();
  });
}
