// Quick Add: one line, parsed as you type (see quickadd.js). A guide under it
// shows what was understood for each field, and the syntax with an example for
// the fields not filled yet; the field being typed is highlighted. Suggestions
// come next. While the name is typed, the suggestions are the existing items
// that look like it, so a typo does not create a second copy of a part: pick
// one (↓ then Enter) to add the new slots, tags and aliases to it instead.
// The dialog stays open to add several parts in a row.

import { h } from '../dom.js';
import { openModal, toast } from '../ui/overlay.js';
import { attachCompletion } from '../ui/complete.js';
import { parseQuickAdd, tokenAt } from '../quickadd.js';
import { similarItems } from '../search.js';
import { normalize } from '../text.js';
import { canonicalSlot } from '../slots.js';
import { api, ApiError } from '../api.js';
import { tagSuggestions, slotSuggestions, slotSummary } from '../suggest.js';

/** kind: 'part' or 'tool', from the tab the dialog was opened from. */
export function openQuickAdd(app, { prefill = '', kind = 'part' } = {}) {
  const tool = kind === 'tool';
  const input = h('input', {
    type: 'text',
    class: 'input quick-input',
    value: prefill,
    placeholder: tool ? 'e.g. Drill brand:Makita ref:DHP482 sn:A12345' : 'e.g. ESP32-WROOM B-2 #electronic/mcu x5',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 400,
    attrs: { 'aria-label': 'New item', autocapitalize: 'off' },
  });
  const guide = h('div', { class: 'quick-guide' });
  const notice = h('div', { class: 'quick-notice', hidden: true });
  const suggestions = h('div', { class: 'quick-suggestions' });
  const submit = h('button', { type: 'submit', class: 'button primary' }, 'Add');
  const form = h('form', { class: 'quick-add-form' }, h('div', { class: 'quick-row' }, input, submit), guide, notice, suggestions);

  const parse = () => parseQuickAdd(input.value, { knownBoxes: app.knownBoxes, kind });
  const similar = (name) => similarItems(app.index, name);

  const completion = attachCompletion(input, () => {
    const caret = input.selectionStart ?? input.value.length;
    const tok = tokenAt(input.value, caret, { knownBoxes: app.knownBoxes, kind });
    const range = { start: tok.start, end: tok.end };
    let completions = [];
    if (tok.type === 'tag') {
      completions = tagSuggestions(app, tok.value, range, { prefix: '#', exclude: parse().tags })
        .filter((s) => s.label !== `#${tok.value.toLowerCase()}`);
    } else if (tok.type === 'slot') {
      completions = slotSuggestions(app, tok.value, range).filter((s) => s.label !== canonicalSlot(tok.value));
    }
    const section = tok.type === 'tag' ? 'Tags' : 'Slots';
    // Look-alikes stay listed under the completions, so finishing a slot or a
    // tag never hides them.
    const matches = similar(parse().name);
    const lookAlike = matches.some((m) => m.exact) ? 'Already in your inventory' : 'Already in your inventory?';
    return {
      items: [
        ...completions.map((c) => ({ ...c, section })),
        ...matches.map((m) => ({
          section: lookAlike,
          label: m.item.name,
          badge: m.exact ? 'same name' : m.matched !== m.item.name ? `alias: ${m.matched}` : null,
          hint: m.item.slots.join(' ') || 'no slot',
          className: m.exact ? 'is-exact' : '',
          pick: () => mergeInto(m.item, !m.exact),
        })),
      ],
    };
  }, { container: suggestions, onChange: () => update() });

  function update() {
    const p = parse();
    const caret = input.selectionStart ?? input.value.length;
    const typing = input.value.trim() ? tokenAt(input.value, caret, { knownBoxes: app.knownBoxes, kind }).type : 'name';
    const chip = (cls, text, title) => h('span', { class: ['chip', cls], title }, text);
    const row = (type, label, values, syntax, example) => h('div', { class: ['guide-row', typing === type && 'typing', values.length && 'filled'] },
      h('span', { class: 'guide-label' }, label),
      values.length
        ? h('span', { class: 'guide-values' }, values)
        : h('span', { class: 'guide-help' }, h('code', null, syntax), ' ', example));
    guide.classList.toggle('blank', !input.value.trim());
    const one = (cls, value) => (value ? [chip(cls, value)] : []);
    const tags = row('tag', 'tags', p.tags.map((t) => chip('tag', app.tagCounts.has(t) ? `#${t}` : `#${t} (new)`)), '#tag', tool ? '#power #measure' : '#electronic/mcu for a sub-tag');
    guide.replaceChildren(...(tool
      ? [
        row('name', 'name', one('name', p.name), 'any words', 'what it is: Drill, Multimeter'),
        row('brand', 'brand', one('brand', p.brand), 'brand:', 'brand:Makita, brand:"Black+Decker"'),
        row('model', 'ref', one('model', p.model), 'ref:', 'the reference: ref:DHP482'),
        row('serial', 'serial', one('serial', p.serial), 'sn:', 'on the label: sn:A12345'),
        row('warranty', 'warranty', p.warrantyError ? [chip('error', 'not a date')] : one('warranty', p.warranty), 'until:', 'warranty end: until:2027-03'),
        tags,
      ]
      : [
        row('name', 'name', one('name', p.name), 'any words', 'what it is: ESP32-WROOM, Velcro strip'),
        row('slot', 'slots', p.slots.map((s) => chip('slot', `${s} · ${slotSummary(app, s)}`)), 'A-12', 'box and slot, several allowed'),
        tags,
        row('alias', 'aliases', p.aliases.map((a) => chip('alias', a)), '~alias', 'other names: ~esp ~"wifi board"'),
        row('quantity', 'qty', p.quantity !== null ? [chip('quantity', String(p.quantity))] : [], 'x5', 'how many (default 0)'),
      ]));

    const exact = p.name ? similar(p.name).find((m) => m.exact) : null;
    notice.hidden = !exact;
    if (exact) {
      notice.replaceChildren(
        exact.item.kind === 'tool'
          ? `“${exact.item.name}” is already in the tools. `
          : `“${exact.item.name}” is already in ${exact.item.slots.join(', ') || 'no slot'}. `,
        h('strong', null, 'Enter'), p.quantity ? ` adds the slots, tags and ${p.quantity} more to it.` : ' adds the slots and tags to it.');
    }
    submit.textContent = exact ? 'Add to it' : 'Add';
  }

  async function mergeInto(item, addNameAsAlias) {
    const p = parse();
    const union = (a, b) => [...a, ...b.filter((x) => !a.some((y) => normalize(y) === normalize(x)))];
    const aliases = union(item.aliases, p.aliases);
    if (addNameAsAlias && p.name && normalize(p.name) !== normalize(item.name)) aliases.push(p.name);
    const undo = app.snapshot([item]);
    const merged = { ...item, tags: union(item.tags, p.tags), aliases: union(aliases, []) };
    if (item.kind === 'tool') {
      // A tool keeps what it has; the line only fills the blanks.
      for (const f of ['brand', 'model', 'serial']) merged[f] = item[f] || p[f];
      merged.warranty_until = item.warranty_until || p.warranty;
    } else {
      merged.slots = union(item.slots, p.slots);
      // New parts of a counted item add up.
      merged.quantity = item.quantity + (p.quantity ?? 0);
    }
    const updated = await app.run(() => api.items.update(item.id, merged));
    if (!updated) return;
    app.putItem(updated);
    const added = p.slots.length ? ` (now in ${updated.slots.join(', ')})` : '';
    app.done(`Updated “${updated.name}”${added}`, undo);
    reset();
  }

  async function create() {
    const p = parse();
    if (!p.name) {
      toast('Type a name first', { type: 'error' });
      return;
    }
    if (p.warrantyError) {
      toast('until: takes a date like 2027, 2027-03 or 2027-03-31', { type: 'error' });
      return;
    }
    const exact = similar(p.name).find((m) => m.exact);
    if (exact) return mergeInto(exact.item, false);
    try {
      const item = await api.items.create(tool
        ? { kind, name: p.name, tags: p.tags, aliases: p.aliases, brand: p.brand, model: p.model, serial: p.serial, warranty_until: p.warranty }
        : { name: p.name, slots: p.slots, tags: p.tags, aliases: p.aliases, quantity: p.quantity ?? 0 });
      app.putItem(item);
      app.done(`Added “${item.name}”${item.slots.length ? ` to ${item.slots.join(', ')}` : ''}`, () => api.items.remove([item.id]));
      if (tool) {
        // Straight to the tool, whose details take the invoice.
        modal.close();
        app.focusItem(item, { open: true });
        return;
      }
      reset();
    } catch (err) {
      // Added from another device in the meantime.
      if (err instanceof ApiError && err.status === 409 && app.byId.has(err.data?.existing_id)) {
        return mergeInto(app.byId.get(err.data.existing_id), false);
      }
      app.report(err);
    }
  }

  function reset() {
    input.value = '';
    update();
    completion.refresh();
    input.focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const chosen = completion.chosen();
    if (chosen?.pick) chosen.pick();
    else create();
  });
  input.addEventListener('input', update);
  // Moving the caret changes which field of the guide is highlighted.
  input.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') update(); });
  input.addEventListener('click', update);

  const modal = openModal({ title: tool ? 'Add a tool' : 'Add parts', body: form, className: 'quick-add' });
  const end = input.value.length;
  input.setSelectionRange(end, end);
  update();
  completion.refresh();
}
