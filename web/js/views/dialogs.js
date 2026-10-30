// Small dialogs: choose a slot, swap two slots, change tags.

import { h } from '../dom.js';
import { openModal } from '../ui/overlay.js';
import { attachCompletion } from '../ui/complete.js';
import { canonicalSlot } from '../slots.js';
import { tokenUnderCaret, tagSuggestions, slotSuggestions, slotSummary } from '../suggest.js';

/** A slot field with completion and a line telling what the slot holds. */
function slotField(app, value, placeholder) {
  const input = h('input', { type: 'text', class: 'input', value, placeholder, autocomplete: 'off', spellcheck: false });
  const info = h('div', { class: 'field-info' });
  const box = h('div', { class: 'field-complete' }, input);
  const update = () => {
    const slot = canonicalSlot(input.value);
    info.textContent = slot ? `${slot}: ${slotSummary(app, slot)}` : input.value.trim() ? 'Write a slot like A-12' : '';
  };
  attachCompletion(input, () => {
    const tok = tokenUnderCaret(input);
    return { items: tok.text ? slotSuggestions(app, tok.text, { start: 0, end: input.value.length }) : [] };
  }, { container: box, onChange: update });
  input.addEventListener('input', update);
  update();
  return { input, el: h('div', { class: 'field' }, box, info), slot: () => canonicalSlot(input.value) };
}

function okOnEnter(modal, inputs, submit) {
  for (const input of inputs) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.defaultPrevented) {
        e.preventDefault();
        submit();
      }
    });
  }
}

/** Resolves to a canonical slot ("A-12"), or null when cancelled. */
export function pickSlot(app, { title, value = '', okText = 'OK' }) {
  return new Promise((resolve) => {
    let answer = null;
    const f = slotField(app, value, 'A-12');
    const submit = () => {
      if (!f.slot()) return f.input.focus();
      answer = f.slot();
      m.close();
    };
    const m = openModal({
      title,
      className: 'dialog',
      body: f.el,
      footer: [
        h('button', { type: 'button', class: 'button', onclick: () => m.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'button primary', onclick: submit }, okText),
      ],
      onClose: () => resolve(answer),
    });
    okOnEnter(m, [f.input], submit);
  });
}

/** Resolves to [a, b], or null. Everything in a goes to b and the other way round. */
export function openSwap(app, from) {
  return new Promise((resolve) => {
    let answer = null;
    const a = slotField(app, from, 'A-12');
    const b = slotField(app, '', 'B-3');
    const submit = () => {
      if (!a.slot()) return a.input.focus();
      if (!b.slot()) return b.input.focus();
      answer = [a.slot(), b.slot()];
      m.close();
    };
    const m = openModal({
      title: 'Swap two slots',
      className: 'dialog',
      body: [
        h('p', { class: 'dialog-message' }, 'Everything in the first slot goes to the second, and the other way round.'),
        a.el,
        h('div', { class: 'swap-arrow' }, '⇅'),
        b.el,
      ],
      footer: [
        h('button', { type: 'button', class: 'button', onclick: () => m.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'button primary', onclick: submit }, 'Swap'),
      ],
      onClose: () => resolve(answer),
    });
    okOnEnter(m, [a.input, b.input], submit);
    (from ? b.input : a.input).focus();
  });
}

/** Resolves to { add, remove } for "tag -other", or null. */
export function openTagDialog(app, items) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h('input', { type: 'text', class: 'input', placeholder: 'tool  -old-tag', autocomplete: 'off', spellcheck: false });
    const box = h('div', { class: 'field-complete' }, input);
    attachCompletion(input, () => {
      const tok = tokenUnderCaret(input);
      const minus = tok.text.startsWith('-');
      const typed = tok.text.replace(/^-?#?/, '');
      // Removing offers the tags these items have; adding offers every tag.
      if (minus) {
        const own = new Set(items.flatMap((it) => it.tags));
        return { items: tagSuggestions(app, typed, tok, { prefix: '-' }).filter((s) => own.has(s.label.slice(1))) };
      }
      return { items: tagSuggestions(app, typed, tok) };
    }, { container: box });
    const submit = () => {
      const words = input.value.split(/\s+/).filter(Boolean);
      answer = {
        add: words.filter((w) => !w.startsWith('-')),
        remove: words.filter((w) => w.startsWith('-')).map((w) => w.slice(1)).filter(Boolean),
      };
      m.close();
    };
    const common = items.length === 1 ? items[0].tags : [];
    const m = openModal({
      title: items.length === 1 ? `Tags of “${items[0].name}”` : `Tags of ${items.length} items`,
      className: 'dialog',
      body: [
        h('p', { class: 'dialog-message' }, 'Type tags to add, and -tag to remove one.'),
        common.length ? h('div', { class: 'chips' }, common.map((t) => h('span', { class: 'chip tag' }, `#${t}`))) : null,
        box,
      ],
      footer: [
        h('button', { type: 'button', class: 'button', onclick: () => m.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'button primary', onclick: submit }, 'Apply'),
      ],
      onClose: () => resolve(answer),
    });
    okOnEnter(m, [input], submit);
  });
}
