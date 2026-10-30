// One form to add an item and to edit it, the same on a computer and on a
// phone. The name lists look-alike items as it is typed, so a typo does not
// make a second copy. A part's slot is picked on the map of an existing box
// (boxes are created in the Boxes view); a tool takes its brand, reference,
// serial number and warranty end instead.

import { h, isMobile } from '../dom.js';
import { openModal, topModal } from '../ui/overlay.js';
import { similarItems } from '../search.js';
import { normalize } from '../text.js';
import { parseSlot } from '../slots.js';
import { api, ApiError } from '../api.js';
import { tagSuggestions } from '../suggest.js';
import { boxIds, boxMap, boxTabs, freeSlots } from './slotmap.js';

/**
 * item: the item to edit; without it, a new one of the given kind, with name
 * or slot filled in from where the form was opened.
 */
export function openItemForm(app, { item = null, kind = 'part', name = '', slot = '' } = {}) {
  const editing = Boolean(item);
  const state = {
    kind: item?.kind || kind,
    slots: item ? [...item.slots] : [],
    tags: item ? [...item.tags] : [],
    several: (item?.slots.length || 0) > 1,
    box: '',
  };
  if (!editing) {
    // A new part goes to the first free slot of the box being looked at.
    const boxes = boxIds(app);
    const near = parseSlot(app.cursorItem()?.slots[0] || '')?.box;
    const box = boxes.includes(near) ? near : boxes[0];
    const free = box && freeSlots(app, box)[0];
    if (slot) state.slots = [slot];
    else if (free) state.slots = [free];
  }
  state.box = parseSlot(state.slots[0] || '')?.box || parseSlot(app.cursorItem()?.slots[0] || '')?.box || boxIds(app)[0] || '';

  const text = (value, props = {}) => h('input', { type: 'text', class: 'input', value: value || '', autocomplete: 'off', spellcheck: false, ...props });
  const field = (label, ...control) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), ...control);

  const error = h('div', { class: 'form-error', hidden: true });
  const kindSeg = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Kind' } });
  const nameInput = text(item?.name ?? name, { maxLength: 200, attrs: { 'aria-label': 'Name', autocapitalize: 'sentences', enterkeyhint: 'next' } });
  const lookAlikes = h('div', { class: 'look-alikes' });

  // Part: slots and a count.
  const several = h('input', { type: 'checkbox', checked: state.several });
  const slotHead = h('div', { class: 'slot-head' });
  const slotBody = h('div', { class: 'slot-body' });
  const qty = h('input', { type: 'number', min: 0, max: 1000000, step: 1, inputMode: 'numeric', value: item ? item.quantity : 1, attrs: { 'aria-label': 'Quantity' } });
  const step = (delta) => { qty.value = String(Math.max(0, (Number(qty.value) || 0) + delta)); };
  const partFields = h('div', { class: 'form-group' },
    field('Slot', slotHead, slotBody),
    field('Quantity', h('div', { class: 'stepper' },
      h('button', { type: 'button', attrs: { 'aria-label': 'One less' }, onclick: () => step(-1) }, '−'),
      qty,
      h('button', { type: 'button', attrs: { 'aria-label': 'One more' }, onclick: () => step(1) }, '+')),
    h('span', { class: 'field-info' }, 'At 0 the part goes to the shopping list.')));

  // Tool: a record.
  const brand = text(item?.brand, { maxLength: 100, attrs: { 'aria-label': 'Brand', list: 'form-brands', autocapitalize: 'words' } });
  const brands = h('datalist', { id: 'form-brands' },
    [...new Set(app.items.map((it) => it.brand).filter(Boolean))].sort().map((b) => h('option', { value: b })));
  const model = text(item?.model, { class: 'input mono', maxLength: 100, attrs: { 'aria-label': 'Reference', autocapitalize: 'characters' } });
  const serial = text(item?.serial, { class: 'input mono', maxLength: 100, attrs: { 'aria-label': 'Serial number', autocapitalize: 'characters' } });
  const warranty = h('input', { type: 'date', class: 'input mono', value: item?.warranty_until || '', attrs: { 'aria-label': 'Warranty until' } });
  const archived = h('input', { type: 'checkbox', checked: item?.status === 'archived' });
  const toolFields = h('div', { class: 'form-group' },
    h('div', { class: 'field-grid' }, field('Brand', brand, brands), field('Reference', model)),
    h('div', { class: 'field-grid' }, field('Serial no.', serial), field('Warranty until', warranty)),
    editing
      ? h('label', { class: 'field-check' }, archived, 'Archived: broken, lost or sold, kept on record')
      : h('span', { class: 'field-info' }, 'No slot and no count for tools. Attach the invoice once it is added.'));

  // Both.
  const tagChips = h('div', { class: 'pick-row' });
  const tagInput = text('', { class: 'input mono', placeholder: 'type a tag, then return', attrs: { 'aria-label': 'Tag', autocapitalize: 'off', enterkeyhint: 'done' } });
  const tagSuggest = h('div', { class: 'pick-row' });
  const aliases = text(item?.aliases.join(', '), { placeholder: 'Other names, separated by commas', maxLength: 1000, attrs: { 'aria-label': 'Also known as' } });
  const description = h('textarea', { class: 'input textarea', value: item?.description || '', placeholder: 'Value, size, reference…', rows: 2, maxLength: 2000, attrs: { 'aria-label': 'Description' } });
  const notes = h('textarea', { class: 'input textarea', value: item?.notes || '', placeholder: 'Datasheet link, where to buy, pinout…', rows: 3, maxLength: 10000, attrs: { 'aria-label': 'Notes' } });
  const hasMore = Boolean(item && (item.aliases.length || item.description || item.notes));

  const form = h('form', { class: 'item-form', onsubmit: (e) => { e.preventDefault(); save(); } },
    error,
    kindSeg,
    field('Name', nameInput, lookAlikes),
    partFields,
    toolFields,
    field('Tags', tagChips, tagInput, tagSuggest),
    h('details', { class: 'form-more', open: hasMore },
      h('summary', null, 'Also known as, description, notes'),
      field('Also known as', aliases),
      field('Description', description),
      field('Notes', notes)),
    editing
      ? h('button', { type: 'button', class: 'button wide danger-text', onclick: () => app.remove([item]) }, `Delete ${item.kind === 'tool' ? 'tool' : 'part'}`)
      : null,
    h('button', { type: 'submit', hidden: true }));

  function title() {
    return `${editing ? 'Edit' : 'New'} ${state.kind}`;
  }

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
    nameInput.placeholder = state.kind === 'part' ? 'e.g. Condensateur 22pF' : 'e.g. Visseuse à chocs';
    const t = modal?.el.querySelector('.modal-title');
    if (t) t.textContent = title();
  }

  function renderSlots() {
    if (!boxIds(app).length) {
      slotHead.replaceChildren();
      slotBody.replaceChildren(
        h('p', { class: 'ds-note' }, 'No box yet. Boxes are created in the Boxes view, with their number of slots.'),
        h('button', { type: 'button', class: 'button', onclick: openBoxes }, 'Create a box'));
      return;
    }
    const chips = state.slots.map((s) => h('button', {
      type: 'button',
      class: 'chip-slot',
      title: `Remove ${s}`,
      attrs: { 'aria-label': `Remove ${s}` },
      onclick: () => {
        state.slots = state.slots.filter((x) => x !== s);
        renderSlots();
      },
    }, s, h('span', { class: 'x' }, '×')));
    slotHead.replaceChildren(
      h('span', { class: 'slot-chips' }, chips.length ? chips : h('span', { class: 'muted' }, 'no slot: tap one below')),
      h('label', { class: 'field-check small' }, several, 'several slots'));
    // A slot can hold several items: say so rather than refuse.
    const shared = state.slots.flatMap((s) => (app.slotMap.get(s) || [])
      .filter((it) => it.id !== item?.id)
      .map((it) => `${s} also holds ${it.name}`));
    slotBody.replaceChildren(
      h('div', { class: 'map-bar' },
        boxTabs(app, state.box, (b) => {
          state.box = b;
          renderSlots();
        }),
        h('button', { type: 'button', class: 'map-box dashed', title: 'Create or resize boxes', onclick: openBoxes }, 'Boxes…')),
      boxMap(app, state.box, { chosen: state.slots, self: item, onTap: tapSlot }),
      ...(shared.length ? [h('p', { class: 'field-warning' }, `${shared.join('; ')}.`)] : []));
  }

  function tapSlot(s) {
    if (several.checked) state.slots = state.slots.includes(s) ? state.slots.filter((x) => x !== s) : [...state.slots, s];
    else state.slots = state.slots.length === 1 && state.slots[0] === s ? [] : [s];
    renderSlots();
  }

  function openBoxes() {
    app.openGrid(state.box, { onClose: renderSlots });
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
    tagSuggest.replaceChildren(...tagSuggestions(app, typed, { start: 0, end: tagInput.value.length }, { exclude: state.tags })
      .slice(0, typed ? 6 : 4)
      .map((s) => h('button', { type: 'button', class: 'pick tag-chip suggest', onclick: () => addTag(s.label) }, `+ ${s.label}`)));
  }

  /** Look-alikes under the name, and whether the form can be saved. */
  function update() {
    const value = nameInput.value.trim();
    const matches = value ? similarItems(app.index, value).filter((m) => m.item.id !== item?.id).slice(0, 3) : [];
    const exact = matches.find((m) => m.exact);
    const where = (it) => (it.kind === 'tool' ? 'tool' : it.slots.join(', ') || 'no slot');
    const open = (it) => () => {
      modal.close();
      app.focusItem(it, { open: true });
    };
    let lines = [];
    if (exact) {
      lines = [h('button', { type: 'button', class: 'look-alike exact', onclick: open(exact.item) },
        editing ? 'Another item has this name: ' : 'Already in the inventory: ',
        h('b', null, `${exact.item.name} · ${where(exact.item)}`), '. Open it →')];
    } else if (!editing) {
      lines = matches.map((m) => h('button', { type: 'button', class: 'look-alike', onclick: open(m.item) },
        'Similar: ', h('b', null, `${m.item.name} · ${where(m.item)}`), m.item.kind === 'tool' ? '' : ' — open it to add to it'));
    }
    lookAlikes.replaceChildren(...lines);
    modal.action.disabled = !value || Boolean(exact);
  }

  async function save() {
    if (modal.action.disabled) return nameInput.value.trim() ? null : nameInput.focus();
    if (tagInput.value.trim()) addTag(tagInput.value);
    error.hidden = true;
    const tool = state.kind === 'tool';
    const payload = {
      kind: state.kind,
      name: nameInput.value,
      slots: tool ? [] : state.slots,
      tags: state.tags,
      aliases: aliases.value.split(',').map((a) => a.trim()).filter(Boolean),
      description: description.value,
      notes: notes.value,
      quantity: tool ? 0 : Math.max(0, Math.round(Number(qty.value) || 0)),
      brand: tool ? brand.value : '',
      model: tool ? model.value : '',
      serial: tool ? serial.value : '',
      warranty_until: tool ? warranty.value : '',
      status: tool && archived.checked ? 'archived' : '',
    };
    modal.action.disabled = true;
    try {
      if (editing) {
        const undo = app.snapshot([item]);
        const updated = await api.items.update(item.id, payload);
        modal.close();
        app.putItem(updated);
        app.done(`Saved “${updated.name}”`, undo);
      } else {
        const created = await api.items.create(payload);
        modal.close();
        app.putItem(created);
        app.done(`Added “${created.name}”${created.slots.length ? ` to ${created.slots.join(', ')}` : ''}`, () => api.items.remove([created.id]));
        app.focusItem(created, { open: isMobile() });
      }
    } catch (err) {
      // Added from another device in the meantime: show that one.
      if (!editing && err instanceof ApiError && err.status === 409 && app.byId.has(err.data?.existing_id)) {
        modal.close();
        return app.focusItem(app.byId.get(err.data.existing_id), { open: true });
      }
      error.textContent = err.message;
      error.hidden = false;
      error.scrollIntoView({ block: 'nearest' });
      update();
    }
  }

  nameInput.addEventListener('input', update);
  // On a phone, return goes to the next field; on a computer it saves.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !isMobile()) return;
    e.preventDefault();
    if (state.kind === 'tool') brand.focus();
    else nameInput.blur();
  });
  several.addEventListener('change', () => {
    if (!several.checked) state.slots = state.slots.slice(0, 1);
    renderSlots();
  });
  tagInput.addEventListener('input', () => {
    if (/[\s,]$/.test(tagInput.value)) addTag(tagInput.value.slice(0, -1));
    else renderTags();
  });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && tagInput.value.trim()) {
      e.preventDefault();
      addTag(tagInput.value);
    }
  });
  // Ctrl+Enter saves, wherever the focus is: tapping a slot or a tag redraws
  // the button, and the focus falls back to the page.
  const saveKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && topModal() === modal) {
      e.preventDefault();
      save();
    }
  };
  window.addEventListener('keydown', saveKey, true);
  if (editing) {
    form.addEventListener('dragover', (e) => e.preventDefault());
    form.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      app.attachFiles(app.byId.get(item.id) || item, [...e.dataTransfer.files]);
    });
  }

  const modal = openModal({
    title: title(),
    className: 'item-modal',
    action: { label: editing ? 'Save' : 'Add', run: save },
    body: form,
    // Editing on a phone: no keyboard until a field is tapped.
    autofocus: !(editing && isMobile()),
    onClose: () => window.removeEventListener('keydown', saveKey, true),
  });
  renderKind();
  renderSlots();
  renderTags();
  update();
  return modal;
}
