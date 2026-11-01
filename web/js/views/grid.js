// A box drawn as a grid of its slots. Move with h/j/k/l, switch box with
// [ and ], open a slot with Enter, add to it with a, and swap two slots with
// s on the first then s (or Enter) on the second, or by dragging one onto the other.
// D deletes the box, once it is empty.

import { h, clear, isTextInput } from '../dom.js';
import { openModal, promptDialog, confirmDialog, toast } from '../ui/overlay.js';
import { parseSlot, slotName, isBoxId } from '../slots.js';
import { api } from '../api.js';

/** onClose: called once the view closes (the item form redraws its boxes). */
export function openGrid(app, boxId, cursorSlot, { onClose } = {}) {
  let box = boxId && app.boxes.some((b) => b.id === boxId) ? boxId : app.boxes[0]?.id;
  let cursor = cursorSlot && parseSlot(cursorSlot)?.box === box ? parseSlot(cursorSlot).number : 1;
  let marked = null; // slot number waiting for its swap partner

  const tabs = h('div', { class: 'grid-tabs' });
  const settings = h('div', { class: 'grid-settings' });
  const grid = h('div', { class: 'grid' });
  const hint = h('div', { class: 'grid-hint' });
  // The same actions as the keys, for touch screens: drag and double-click do not work there.
  const actions = h('div', { class: 'grid-actions' });
  const body = h('div', { class: 'grid-view' }, tabs, settings, grid, hint, actions);

  const config = () => app.boxes.find((b) => b.id === box) || { id: box, slots: 0, columns: 0 };
  const used = () => [...app.slotMap.keys()].map(parseSlot).filter((s) => s?.box === box).map((s) => s.number);
  const size = () => Math.max(config().slots, ...used(), 1);
  // Parts in the box (a part in two of its slots counts once).
  const parts = () => new Set([...app.slotMap].filter(([s]) => parseSlot(s)?.box === box).flatMap(([, items]) => items.map((it) => it.id))).size;
  const columns = () => config().columns || Math.min(6, size());

  function render() {
    clear(tabs);
    for (const b of app.boxes) {
      tabs.append(h('button', { type: 'button', class: ['grid-tab', b.id === box && 'active'], onclick: () => switchBox(b.id) }, b.id));
    }
    tabs.append(h('button', { type: 'button', class: 'grid-tab new', title: 'New box', onclick: newBox }, '+'));
    if (!box) {
      clear(settings);
      clear(grid);
      clear(actions);
      hint.textContent = 'No boxes yet: create one with +.';
      return;
    }
    renderSettings();
    clear(grid);
    grid.style.gridTemplateColumns = `repeat(${columns()}, minmax(0, 1fr))`;
    for (let n = 1; n <= size(); n++) {
      const slot = slotName({ box, number: n });
      const items = app.slotMap.get(slot) || [];
      const cell = h('div', {
        class: ['cell', !items.length && 'empty', n === cursor && 'cursor', n === marked && 'marked'],
        draggable: true,
        title: items.map((it) => it.name).join('\n') || 'empty',
        // While a slot waits for its swap partner, tapping another one swaps them.
        onclick: () => {
          if (marked && marked !== n) return swap(marked, n);
          cursor = n;
          render();
        },
        ondblclick: () => open(n),
        ondragstart: (e) => e.dataTransfer.setData('text/plain', String(n)),
        ondragover: (e) => e.preventDefault(),
        ondrop: (e) => {
          e.preventDefault();
          const from = Number(e.dataTransfer.getData('text/plain'));
          if (from && from !== n) swap(from, n);
        },
      },
      h('span', { class: 'cell-number' }, n),
      items.slice(0, 3).map((it) => h('span', { class: 'cell-item' }, it.name)),
      items.length > 3 ? h('span', { class: 'cell-more' }, `+${items.length - 3}`) : null);
      grid.append(cell);
    }
    hint.textContent = marked
      ? `swap ${slotName({ box, number: marked })} with… (tap or s on the other slot, esc to cancel)`
      : '';
    const here = slotName({ box, number: cursor });
    const button = (key, label, run, className) => h('button', { type: 'button', class: ['button', className], onclick: run }, h('kbd', null, key), label);
    actions.replaceChildren(
      button('⏎', `open ${here}`, () => open(cursor)),
      button('a', 'add here', () => { modal.close(); app.add({ slot: here }); }),
      marked
        ? button('esc', 'cancel swap', () => { marked = null; render(); })
        : button('s', `swap ${here}…`, () => { marked = cursor; render(); }, 'primary'));
    grid.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
  }

  function renderSettings() {
    const c = config();
    const slots = h('input', { type: 'number', class: 'input small', min: 0, max: 999, value: c.slots || '', placeholder: String(size()) });
    const cols = h('input', { type: 'number', class: 'input small', min: 0, max: 50, value: c.columns || '', placeholder: String(columns()) });
    const save = async () => {
      const data = await app.run(() => api.setBox(box, Number(slots.value) || 0, Number(cols.value) || 0));
      if (data) {
        app.setInventory(data);
        cursor = Math.min(cursor, size());
        render();
      }
    };
    for (const input of [slots, cols]) {
      input.addEventListener('change', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });
    }
    const inside = parts();
    settings.replaceChildren(
      h('label', null, 'Slots', slots),
      h('label', null, 'Columns', cols),
      h('span', { class: 'grid-count' }, `${used().length} used, ${Math.max(0, size() - used().length)} free`),
      h('span', { class: 'grid-delete' },
        // A box with parts cannot go: say what is in the way, and show it.
        inside
          ? [h('span', { class: 'field-info' }, `${inside} part${inside === 1 ? '' : 's'} inside: move them first`),
            h('button', { type: 'button', class: 'link-button', onclick: () => { modal.close(); app.setQuery(`@${box}`); } }, 'Show them')]
          : null,
        h('button', {
          type: 'button',
          class: 'button danger-text',
          disabled: inside > 0,
          title: inside ? 'Only an empty box can be deleted' : `Delete box ${box}`,
          onclick: deleteBox,
        }, `Delete box ${box}`)));
  }

  async function deleteBox() {
    if (parts()) return toast(`Box ${box} still holds parts: move or delete them first`, { type: 'error' });
    const { id, slots, columns } = config();
    if (!(await confirmDialog(`Delete box ${id}?`, `Its ${slots || size()} slots are empty. Undo brings it back.`, { okText: 'Delete box' }))) return;
    const data = await app.run(() => api.deleteBox(id));
    if (!data) return;
    app.setInventory(data);
    app.done(`Deleted box ${id}`, async () => {
      const restored = await api.setBox(id, slots, columns);
      // Undone with the view still open: show the box again.
      if (modal.el.isConnected) {
        app.setInventory(restored);
        render();
      }
      return restored;
    });
    box = app.boxes[0]?.id;
    cursor = 1;
    marked = null;
    render();
    modal.el.focus();
  }

  function switchBox(id) {
    box = id;
    cursor = 1;
    marked = null;
    render();
  }

  async function newBox() {
    const id = await promptDialog('New box', { placeholder: 'Box id, like A or B2', okText: 'Create' });
    if (!id) return;
    if (!isBoxId(id)) return toast('A box id is a letter followed by letters or digits, like A or B2', { type: 'error' });
    const upper = id.trim().toUpperCase();
    if (!app.boxes.some((b) => b.id === upper)) {
      const data = await app.run(() => api.setBox(upper, 24, 6));
      if (!data) return;
      app.setInventory(data);
    }
    switchBox(upper);
    // The keys work again: the dialog took the focus and the + it came from is redrawn.
    modal.el.focus();
  }

  function open(n) {
    modal.close();
    app.setQuery(slotName({ box, number: n }));
  }

  async function swap(a, b) {
    marked = null;
    await app.swapSlots(slotName({ box, number: a }), slotName({ box, number: b }));
    render();
  }

  function moveCursor(dx, dy) {
    const cols = columns();
    let n = cursor + dx + dy * cols;
    if (n < 1 || n > size()) return;
    cursor = n;
    render();
  }

  const modal = openModal({
    title: 'Boxes',
    className: 'grid-modal',
    body,
    autofocus: false,
    onClose,
    onEscape: () => {
      if (marked) {
        marked = null;
        render();
      } else {
        modal.close();
      }
    },
  });

  modal.el.addEventListener('keydown', (e) => {
    if (isTextInput(e.target) || e.ctrlKey || e.metaKey || e.altKey || !box) return;
    const ids = app.boxes.map((b) => b.id);
    const handled = {
      h: () => moveCursor(-1, 0), ArrowLeft: () => moveCursor(-1, 0),
      l: () => moveCursor(1, 0), ArrowRight: () => moveCursor(1, 0),
      k: () => moveCursor(0, -1), ArrowUp: () => moveCursor(0, -1),
      j: () => moveCursor(0, 1), ArrowDown: () => moveCursor(0, 1),
      '[': () => switchBox(ids[(ids.indexOf(box) - 1 + ids.length) % ids.length]),
      ']': () => switchBox(ids[(ids.indexOf(box) + 1) % ids.length]),
      Enter: () => (marked ? swap(marked, cursor) : open(cursor)),
      s: () => {
        if (marked && marked !== cursor) swap(marked, cursor);
        else {
          marked = marked ? null : cursor;
          render();
        }
      },
      a: () => {
        modal.close();
        app.add({ slot: slotName({ box, number: cursor }) });
      },
      D: deleteBox,
    }[e.key];
    if (handled) {
      e.preventDefault();
      handled();
    }
  });

  render();
  return modal;
}
