// Small dialogs: swap two slots by their ids, change tags, type a quantity.

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

/** Asks for a quantity. Resolves to a whole number, or null when cancelled. */
export function openQuantityDialog(item) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h('input', {
      type: 'number', class: 'input qty-input', min: 0, max: 1000000, step: 1, inputMode: 'numeric', value: item.quantity,
    });
    const error = h('div', { class: 'field-info' });
    const step = (delta) => {
      input.value = String(Math.max(0, (Number(input.value) || 0) + delta));
      input.focus();
    };
    const submit = () => {
      const value = Number(input.value);
      if (input.value.trim() === '' || !Number.isInteger(value) || value < 0) {
        error.textContent = 'a whole number, 0 or more';
        return input.focus();
      }
      answer = value;
      m.close();
    };
    const m = openModal({
      title: `qty: ${item.name}`,
      className: 'dialog',
      body: [
        h('div', { class: 'qty-dialog' },
          h('button', { type: 'button', class: 'button qty-big', onclick: () => step(-1) }, '−'),
          input,
          h('button', { type: 'button', class: 'button qty-big', onclick: () => step(1) }, '+')),
        error,
        h('p', { class: 'dialog-message' }, 'dropping to 0 puts it on the shopping list.'),
      ],
      footer: [
        h('button', { type: 'button', class: 'button', onclick: () => m.close() }, 'cancel'),
        h('button', { type: 'button', class: 'button primary', onclick: submit }, 'set'),
      ],
      onClose: () => resolve(answer),
    });
    okOnEnter(m, [input], submit);
    input.select();
  });
}
