// Quick Add: one line, parsed as you type (see quickadd.js), with suggestions
// under it. While the name is typed, the suggestions are the existing items
// that look like it, so a typo does not create a second copy of a part: pick
// one (↓ then Enter) to add the new slots, tags and aliases to it instead.
// The dialog stays open to add several parts in a row.

import { h, clear } from '../dom.js';
import { openModal, toast } from '../ui/overlay.js';
import { attachCompletion } from '../ui/complete.js';
import { parseQuickAdd, tokenAt } from '../quickadd.js';
import { similarItems } from '../search.js';
import { normalize } from '../text.js';
import { canonicalSlot } from '../slots.js';
import { api, ApiError } from '../api.js';
import { tagSuggestions, slotSuggestions, slotSummary } from '../suggest.js';

export function openQuickAdd(app, { prefill = '' } = {}) {
  const input = h('input', {
    type: 'text',
    class: 'input quick-input',
    value: prefill,
    placeholder: 'Name  A-12  #tag  ~alias  !low',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 400,
    attrs: { 'aria-label': 'New item', autocapitalize: 'off' },
  });
  const parsed = h('div', { class: 'quick-parsed' });
  const notice = h('div', { class: 'quick-notice', hidden: true });
  const suggestions = h('div', { class: 'quick-suggestions' });
  const submit = h('button', { type: 'submit', class: 'button primary' }, 'Add');
  const form = h('form', { class: 'quick-add-form' }, h('div', { class: 'quick-row' }, input, submit), parsed, notice, suggestions);

  const parse = () => parseQuickAdd(input.value, { knownBoxes: app.knownBoxes });
  const similar = (name) => similarItems(app.index, name);

  const completion = attachCompletion(input, () => {
    const caret = input.selectionStart ?? input.value.length;
    const tok = tokenAt(input.value, caret, { knownBoxes: app.knownBoxes });
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
    clear(parsed);
    const chip = (cls, text, title) => h('span', { class: ['chip', cls], title }, text);
    if (p.name) parsed.append(chip('name', p.name));
    for (const s of p.slots) parsed.append(chip('slot', `${s} · ${slotSummary(app, s)}`));
    for (const t of p.tags) parsed.append(chip('tag', `#${t}`, app.tagCounts.has(t) ? '' : 'New tag'));
    for (const a of p.aliases) parsed.append(chip('alias', a));
    if (p.stock) parsed.append(chip(`stock ${p.stock}`, p.stock));

    const exact = p.name ? similar(p.name).find((m) => m.exact) : null;
    notice.hidden = !exact;
    if (exact) {
      notice.replaceChildren(
        `“${exact.item.name}” is already in ${exact.item.slots.join(', ') || 'no slot'}. `,
        h('strong', null, 'Enter'), ' adds the slots and tags to it.');
    }
    submit.textContent = exact ? 'Add to it' : 'Add';
  }

  async function mergeInto(item, addNameAsAlias) {
    const p = parse();
    const union = (a, b) => [...a, ...b.filter((x) => !a.some((y) => normalize(y) === normalize(x)))];
    const aliases = union(item.aliases, p.aliases);
    if (addNameAsAlias && p.name && normalize(p.name) !== normalize(item.name)) aliases.push(p.name);
    const undo = app.snapshot([item]);
    const updated = await app.run(() => api.items.update(item.id, {
      ...item,
      slots: union(item.slots, p.slots),
      tags: union(item.tags, p.tags),
      aliases: union(aliases, []),
      stock: p.stock || item.stock,
    }));
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
    const exact = similar(p.name).find((m) => m.exact);
    if (exact) return mergeInto(exact.item, false);
    try {
      const item = await api.items.create({ name: p.name, slots: p.slots, tags: p.tags, aliases: p.aliases, stock: p.stock });
      app.putItem(item);
      app.done(`Added “${item.name}”${item.slots.length ? ` to ${item.slots.join(', ')}` : ''}`, () => api.items.remove([item.id]));
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

  openModal({ title: 'Add parts', body: form, className: 'quick-add' });
  const end = input.value.length;
  input.setSelectionRange(end, end);
  update();
  completion.refresh();
}
