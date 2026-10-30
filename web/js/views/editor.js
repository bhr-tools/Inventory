// Full editor of one item. Slots and tags complete like in Quick Add, and the
// name warns about look-alike items. The kind can be switched: a part has
// slots and a count, a tool brand, reference, serial, warranty and status.
// Files dropped on the dialog are attached to the item.

import { h } from '../dom.js';
import { openModal } from '../ui/overlay.js';
import { attachCompletion } from '../ui/complete.js';
import { similarItems } from '../search.js';
import { canonicalSlot } from '../slots.js';
import { api } from '../api.js';
import { tokenUnderCaret, tagSuggestions, slotSuggestions } from '../suggest.js';

export function openEditor(app, item) {
  const field = (label, control, hint) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label), control, hint || null);
  const text = (value, placeholder, extra = {}) => h('input', {
    type: 'text', class: 'input', value, placeholder, autocomplete: 'off', spellcheck: false, ...extra,
  });

  const name = text(item.name, 'Name', { maxLength: 200 });
  const nameWarning = h('div', { class: 'field-warning', hidden: true });
  const slots = text(item.slots.join(' '), 'A-12 B-3');
  const tags = text(item.tags.join(' '), 'electronic/mcu tool');
  const aliases = text(item.aliases.join(', '), 'Other names, separated by commas');
  const quantity = h('input', {
    type: 'number', class: 'input', min: 0, max: 1000000, step: 1, inputMode: 'numeric',
    value: item.quantity,
  });
  const kind = h('select', { class: 'input' },
    [['part', 'part: slots and a count'], ['tool', 'tool: a record, with its files']]
      .map(([v, label]) => h('option', { value: v, selected: (item.kind || 'part') === v }, label)));
  const brand = text(item.brand || '', 'Makita', { maxLength: 100 });
  const model = text(item.model || '', 'DHP482', { maxLength: 100 });
  const serial = text(item.serial || '', 'On the label', { maxLength: 100 });
  const warrantyUntil = h('input', { type: 'date', class: 'input', value: item.warranty_until || '' });
  const status = h('select', { class: 'input' },
    [['', 'in use'], ['broken', 'broken'], ['lost', 'lost']]
      .map(([v, label]) => h('option', { value: v, selected: (item.status || '') === v }, label)));
  const description = h('textarea', { class: 'input textarea', value: item.description, placeholder: 'Value, size, reference…', rows: 2, maxLength: 2000 });
  const notes = h('textarea', { class: 'input textarea', value: item.notes, placeholder: 'Datasheet link, where to buy, pinout…', rows: 4, maxLength: 10000 });
  const error = h('div', { class: 'form-error', hidden: true });

  const slotBox = h('div', { class: 'field-complete' }, slots);
  const tagBox = h('div', { class: 'field-complete' }, tags);
  attachCompletion(slots, () => {
    const tok = tokenUnderCaret(slots);
    return { items: tok.text ? slotSuggestions(app, tok.text, tok) : [] };
  }, { container: slotBox });
  attachCompletion(tags, () => {
    const tok = tokenUnderCaret(tags);
    const typed = tok.text.replace(/^#/, '');
    const current = tags.value.split(/\s+/).filter(Boolean);
    return { items: tagSuggestions(app, typed, tok, { exclude: current }) };
  }, { container: tagBox });

  name.addEventListener('input', () => {
    const others = similarItems(app.index, name.value).filter((m) => m.item.id !== item.id);
    const top = others[0];
    nameWarning.hidden = !top || top.score < 0.6;
    if (!nameWarning.hidden) {
      nameWarning.replaceChildren(
        top.exact ? 'Another item already has this name: ' : 'Looks like ',
        h('button', { type: 'button', class: 'link', onclick: () => { modal.close(); openEditor(app, top.item); } }, top.item.name),
        ` (${top.item.slots.join(', ') || 'no slot'})`);
    }
  });

  async function save() {
    error.hidden = true;
    const isTool = kind.value === 'tool';
    const slotList = isTool ? [] : slots.value.split(/[\s,]+/).filter(Boolean);
    const bad = slotList.find((s) => !canonicalSlot(s));
    if (bad) {
      error.textContent = `“${bad}” is not a slot: write it like A-12.`;
      error.hidden = false;
      return;
    }
    const undo = app.snapshot([item]);
    try {
      const updated = await api.items.update(item.id, {
        kind: kind.value,
        name: name.value,
        slots: slotList,
        tags: tags.value.split(/\s+/).filter(Boolean),
        aliases: aliases.value.split(',').map((a) => a.trim()).filter(Boolean),
        quantity: isTool ? 0 : Number(quantity.value) || 0,
        brand: isTool ? brand.value : '',
        model: isTool ? model.value : '',
        serial: isTool ? serial.value : '',
        warranty_until: isTool ? warrantyUntil.value : '',
        status: isTool ? status.value : '',
        description: description.value,
        notes: notes.value,
      });
      modal.close();
      app.putItem(updated);
      app.done(`Saved “${updated.name}”`, undo);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  const partFields = h('div', { class: 'field-pair' },
    field('Slots', slotBox),
    field('Quantity', quantity, h('span', { class: 'field-info' }, 'dropping to 0: shopping list')));
  const toolFields = h('div', { class: 'field-grid' },
    field('Brand', brand),
    field('Reference', model),
    field('Serial number', serial),
    field('Warranty until', warrantyUntil),
    field('Status', status));
  const body = h('form', { class: 'editor', onsubmit: (e) => { e.preventDefault(); save(); } },
    error,
    field('Name', name, nameWarning),
    field('Kind', kind),
    partFields,
    toolFields,
    field('Tags', tagBox),
    field('Also known as', aliases),
    field('Description', description),
    field('Notes', notes),
    h('button', { type: 'submit', hidden: true }));
  const showKind = () => {
    partFields.hidden = kind.value === 'tool';
    toolFields.hidden = kind.value !== 'tool';
  };
  kind.addEventListener('change', showKind);
  showKind();
  body.addEventListener('dragover', (e) => e.preventDefault());
  body.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    app.attachFiles(app.byId.get(item.id) || item, [...e.dataTransfer.files]);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  });

  const modal = openModal({
    title: item.kind === 'tool' ? 'Edit tool' : 'Edit part',
    className: 'editor-modal',
    body,
    footer: [
      h('button', { type: 'button', class: 'button danger-text', onclick: () => app.remove([item]) }, 'Delete'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'button', onclick: () => modal.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'button primary', onclick: save }, 'Save', h('kbd', null, 'Ctrl ⏎')),
    ],
  });
  return modal;
}
