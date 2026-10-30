// Phones: adding is a short form rather than the Quick Add line. The name
// warns about look-alikes as it is typed (open one to add to it instead), the
// slot is picked among the free ones of a box, and the count is set with − / +.
// A tool takes its brand, reference, serial number and warranty end instead.

import { h } from '../dom.js';
import { openModal } from '../ui/overlay.js';
import { parseQuickAdd } from '../quickadd.js';
import { similarItems } from '../search.js';
import { normalize } from '../text.js';
import { parseSlot } from '../slots.js';
import { api, ApiError } from '../api.js';
import { tagSuggestions } from '../suggest.js';
import { boxIds, freeSlots, openSlotMap } from './slotmap.js';

/** prefill: Quick Add text ("A-12", a name…) from where the form was opened. */
export function openAddForm(app, { kind = 'part', prefill = '' } = {}) {
  const parsed = parseQuickAdd(prefill, { knownBoxes: app.knownBoxes, kind: 'part' });
  const cursorBox = parseSlot(app.cursorItem()?.slots[0] || '')?.box;
  const state = {
    kind,
    slot: parsed.slots[0] || '',
    box: '',
    tags: [...parsed.tags],
  };
  state.box = state.slot ? parseSlot(state.slot).box : cursorBox || boxIds(app)[0] || 'A';
  if (!state.slot) state.slot = freeSlots(app, state.box)[0] || '';

  const text = (props) => h('input', { type: 'text', class: 'input', autocomplete: 'off', spellcheck: false, ...props });
  const field = (label, ...control) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), ...control);

  const name = text({ value: parsed.name, maxLength: 200, attrs: { 'aria-label': 'Description', autocapitalize: 'sentences', enterkeyhint: 'next' } });
  const lookAlikes = h('div', { class: 'look-alikes' });
  const kindSeg = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Kind' } });

  // Part
  const boxRow = h('div', { class: 'pick-row', attrs: { role: 'group', 'aria-label': 'Box' } });
  const slotRow = h('div', { class: 'pick-row', attrs: { role: 'group', 'aria-label': 'Slot' } });
  const qty = h('input', { type: 'number', min: 0, max: 1000000, step: 1, inputMode: 'numeric', value: parsed.quantity ?? 1, attrs: { 'aria-label': 'Quantity' } });
  const step = (delta) => { qty.value = String(Math.max(0, (Number(qty.value) || 0) + delta)); };
  const stepper = h('div', { class: 'stepper' },
    h('button', { type: 'button', attrs: { 'aria-label': 'One less' }, onclick: () => step(-1) }, '−'),
    qty,
    h('button', { type: 'button', attrs: { 'aria-label': 'One more' }, onclick: () => step(1) }, '+'));
  const tagChips = h('div', { class: 'pick-row' });
  const tagInput = text({ class: 'input mono', placeholder: 'type, then return', attrs: { 'aria-label': 'Tag', autocapitalize: 'off', enterkeyhint: 'done' } });
  const tagSuggest = h('div', { class: 'pick-row' });
  const partFields = h('div', null,
    field('Slot · free in box', boxRow, slotRow),
    field('Quantity', stepper),
    field('Tags', tagChips, tagInput, tagSuggest));

  // Tool
  const brand = text({ maxLength: 100, attrs: { 'aria-label': 'Brand', list: 'add-brands', autocapitalize: 'words' } });
  const brands = h('datalist', { id: 'add-brands' },
    [...new Set(app.items.map((it) => it.brand).filter(Boolean))].sort().map((b) => h('option', { value: b })));
  const model = text({ class: 'input mono', maxLength: 100, attrs: { 'aria-label': 'Reference', autocapitalize: 'characters' } });
  const serial = text({ class: 'input mono', maxLength: 100, attrs: { 'aria-label': 'Serial number', autocapitalize: 'characters' } });
  const warranty = h('input', { type: 'date', class: 'input mono', attrs: { 'aria-label': 'Warranty until' } });
  const toolFields = h('div', null,
    field('Brand', brand, brands),
    field('Reference', model),
    field('Serial no.', serial),
    field('Warranty until', warranty),
    h('p', { class: 'field-info' }, 'No slot and no count for tools. Attach the invoice once it is added.'));

  const form = h('form', { class: 'add-form', onsubmit: (e) => { e.preventDefault(); save(); } },
    kindSeg,
    field('Description', name, lookAlikes),
    partFields,
    toolFields,
    h('button', { type: 'submit', hidden: true }));

  function renderKind() {
    kindSeg.replaceChildren(...['part', 'tool'].map((k) => h('button', {
      type: 'button',
      class: state.kind === k && 'active',
      attrs: { 'aria-pressed': String(state.kind === k) },
      onclick: () => {
        state.kind = k;
        renderKind();
        update();
      },
    }, k)));
    partFields.hidden = state.kind !== 'part';
    toolFields.hidden = state.kind !== 'tool';
    name.placeholder = state.kind === 'part' ? 'e.g. Condensateur 22pF' : 'e.g. Visseuse à chocs';
    modal.el.querySelector('.modal-title').textContent = `New ${state.kind}`;
  }

  function renderSlots() {
    const boxes = boxIds(app);
    boxRow.replaceChildren(...(boxes.length ? boxes : [state.box]).map((b) => h('button', {
      type: 'button',
      class: ['pick', b === state.box && 'active'],
      onclick: () => {
        state.box = b;
        state.slot = freeSlots(app, b)[0] || '';
        renderSlots();
        update();
      },
    }, `Box ${b}`)));
    const free = freeSlots(app, state.box).slice(0, 5);
    if (state.slot && !free.includes(state.slot)) free.unshift(state.slot);
    slotRow.replaceChildren(
      ...free.map((s) => h('button', {
        type: 'button',
        class: ['pick', s === state.slot && 'active'],
        attrs: { 'aria-pressed': String(s === state.slot) },
        onclick: () => {
          state.slot = s;
          renderSlots();
          update();
        },
      }, `${s === state.slot ? '■' : '□'} ${s}`)),
      h('button', {
        type: 'button',
        class: 'pick dashed',
        onclick: async () => {
          const s = await openSlotMap(app, { box: state.box, slot: state.slot });
          if (!s) return;
          state.slot = s;
          state.box = parseSlot(s).box;
          renderSlots();
          update();
        },
      }, 'map…'));
  }

  function addTag(raw) {
    const tag = normalize(raw.trim().replace(/^#/, '')).replace(/\s+/g, '-');
    tagInput.value = '';
    if (tag && !state.tags.includes(tag)) state.tags.push(tag);
    renderTags();
  }

  function renderTags() {
    tagChips.replaceChildren(...state.tags.map((t) => h('button', {
      type: 'button',
      class: 'pick tag-chip',
      attrs: { 'aria-label': `Remove the tag ${t}` },
      onclick: () => {
        state.tags = state.tags.filter((x) => x !== t);
        renderTags();
      },
    }, `${t} ×`)));
    const typed = tagInput.value.trim().replace(/^#/, '');
    const range = { start: 0, end: tagInput.value.length };
    tagSuggest.replaceChildren(...tagSuggestions(app, typed, range, { exclude: state.tags })
      .slice(0, typed ? 6 : 4)
      .map((s) => h('button', { type: 'button', class: 'pick tag-chip suggest', onclick: () => addTag(s.label) }, `+ ${s.label}`)));
  }

  /** Look-alikes under the name, and whether Add is possible. */
  function update() {
    const value = name.value.trim();
    const matches = value ? similarItems(app.index, value).slice(0, 3) : [];
    const exact = matches.find((m) => m.exact);
    const where = (it) => (it.kind === 'tool' ? 'tool' : it.slots.join(', ') || 'no slot');
    const open = (it) => () => {
      modal.close();
      app.focusItem(it, { open: true });
    };
    lookAlikes.replaceChildren(...(exact
      ? [h('button', { type: 'button', class: 'look-alike exact', onclick: open(exact.item) },
        'Already in the inventory: ', h('b', null, `${exact.item.name} · ${where(exact.item)}`), '. Open it →')]
      : matches.map((m) => h('button', { type: 'button', class: 'look-alike', onclick: open(m.item) },
        'Similar: ', h('b', null, `${m.item.name} · ${where(m.item)}`), m.item.kind === 'tool' ? '' : ' — add to it instead'))));
    modal.action.disabled = !value || Boolean(exact) || (state.kind === 'part' && !state.slot);
  }

  async function save() {
    if (modal.action.disabled) return name.value.trim() ? null : name.focus();
    if (tagInput.value.trim()) addTag(tagInput.value);
    const payload = state.kind === 'tool'
      ? { kind: 'tool', name: name.value, tags: state.tags, brand: brand.value, model: model.value, serial: serial.value, warranty_until: warranty.value }
      : { name: name.value, slots: state.slot ? [state.slot] : [], tags: state.tags, quantity: Math.max(0, Math.round(Number(qty.value) || 0)) };
    modal.action.disabled = true;
    try {
      const item = await api.items.create(payload);
      app.putItem(item);
      app.done(`Added “${item.name}”${item.slots.length ? ` to ${item.slots.join(', ')}` : ''}`, () => api.items.remove([item.id]));
      modal.close();
      app.focusItem(item, { open: true });
    } catch (err) {
      // Added from another device in the meantime: show that one.
      if (err instanceof ApiError && err.status === 409 && app.byId.has(err.data?.existing_id)) {
        modal.close();
        return app.focusItem(app.byId.get(err.data.existing_id), { open: true });
      }
      app.report(err);
      update();
    }
  }

  name.addEventListener('input', update);
  name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (state.kind === 'tool') brand.focus();
    else name.blur();
  });
  tagInput.addEventListener('input', () => {
    if (/[\s,]$/.test(tagInput.value)) addTag(tagInput.value.slice(0, -1));
    else renderTags();
  });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(tagInput.value);
    }
  });

  const modal = openModal({
    title: `New ${kind}`,
    className: 'add-modal',
    action: { label: 'Add', run: save },
    body: form,
  });
  renderKind();
  renderSlots();
  renderTags();
  update();
  name.focus();
  return modal;
}
