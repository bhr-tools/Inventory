// Autocompletion under a text field. A provider looks at the field and returns
//   { title?, items: [{ label, hint?, badge?, className?, section?, insert? | pick? }] }
// where insert replaces the token under the caret ({ start, end, text }) and
// pick runs any other action. Items with a section get a heading each time
// the section changes. Keys: ↓/↑ (or Ctrl+J/K, Ctrl+N/P) move, Tab takes the
// highlighted suggestion (or the first one that completes text), Enter takes
// it only once the list was navigated, so a plain Enter still submits the form.

import { h, clear } from '../dom.js';

export function attachCompletion(input, provider, { container, onChange } = {}) {
  const list = h('div', { class: 'complete', attrs: { role: 'listbox' } });
  (container || input.parentElement).append(list);
  let items = [];
  let active = -1;
  let navigated = false;
  let title = '';

  function refresh() {
    const res = provider(input) || { items: [] };
    items = res.items || [];
    title = res.title || '';
    active = items.length ? 0 : -1;
    navigated = false;
    render();
  }

  function render() {
    clear(list);
    list.hidden = items.length === 0;
    if (!items.length) return;
    if (title) list.append(h('div', { class: 'complete-title' }, title));
    let section = null;
    const tabTarget = navigated ? -1 : items.findIndex((item) => item.insert);
    items.forEach((item, i) => {
      if (item.section && item.section !== section) list.append(h('div', { class: 'complete-title' }, item.section));
      section = item.section;
      list.append(h('button', {
        type: 'button',
        tabIndex: -1,
        class: ['complete-item', item.className, i === active && navigated && 'active', i === tabTarget && 'first'],
        attrs: { role: 'option' },
        onmousedown: (e) => e.preventDefault(), // keep the focus in the field
        onclick: () => take(i),
      },
      item.badge ? h('span', { class: 'complete-badge' }, item.badge) : null,
      h('span', { class: 'complete-label' }, item.label),
      item.hint ? h('span', { class: 'complete-hint' }, item.hint) : null));
    });
  }

  function move(delta) {
    if (!items.length) return;
    active = navigated ? (active + delta + items.length) % items.length : delta > 0 ? 0 : items.length - 1;
    navigated = true;
    render();
    list.querySelectorAll('.complete-item')[active]?.scrollIntoView({ block: 'nearest' });
  }

  function take(i) {
    const item = items[i];
    if (!item) return;
    if (item.insert) {
      const { start, end, text } = item.insert;
      const value = input.value;
      const tail = value.slice(end);
      const glue = tail.startsWith(' ') || text.endsWith(' ') ? '' : ' ';
      input.value = value.slice(0, start) + text + glue + tail;
      const caret = start + text.length + glue.length;
      input.setSelectionRange(caret, caret);
      onChange?.();
      refresh();
    } else {
      item.pick?.();
    }
  }

  input.addEventListener('input', refresh);
  input.addEventListener('click', refresh);
  input.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'ArrowDown' || (ctrl && (e.key === 'j' || e.key === 'n'))) {
      if (!items.length) return;
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp' || (ctrl && (e.key === 'k' || e.key === 'p'))) {
      if (!items.length) return;
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Tab' && !e.shiftKey && items.length) {
      const i = navigated ? active : items.findIndex((item) => item.insert);
      if (i < 0) return;
      e.preventDefault();
      take(i);
    } else if (e.key === 'Enter' && navigated && active >= 0 && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      take(active);
    }
  });

  return {
    refresh,
    /** The highlighted suggestion once the list was navigated, else null. */
    chosen: () => (navigated && active >= 0 ? items[active] : null),
    hide() {
      items = [];
      render();
    },
  };
}
