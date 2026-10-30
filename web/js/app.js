// Inventory web app: one fzf-like view. The search field filters the list on
// every keystroke; the pane on the right previews the item under the cursor.

import { api, ApiError, onUnauthorized } from './api.js';
import { h, icon, clear, isMobile } from './dom.js';
import { openModal, openMenu, closeAllModals, topModal, toast } from './ui/overlay.js';
import { parseQuery, indexItem, search, highlight } from './search.js';
import { parseSlot, slotName, compareSlots } from './slots.js';
import { slotSummary } from './suggest.js';
import { initKeys } from './keys.js';
import { openQuickAdd } from './views/add.js';
import { openEditor } from './views/editor.js';
import { pickSlot, openSwap, openTagDialog, openQuantityDialog } from './views/dialogs.js';
import { openGrid } from './views/grid.js';
import { openTags } from './views/tags.js';
import { openHelp } from './views/help.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 300; // rendered at once; the count shows the rest

class App {
  constructor() {
    this.items = [];
    this.boxes = [];
    this.index = [];
    this.byId = new Map();
    this.slotMap = new Map(); // "A-12" → items
    this.tagCounts = new Map(); // tag → item count, with parent tags
    this.knownBoxes = new Set();
    const params = new URLSearchParams(location.search);
    this.query = params.get('q') || '';
    // 'inventory', or 'shopping': the items whose quantity dropped to 0 (to_buy).
    this.view = params.get('view') === 'shopping' ? 'shopping' : 'inventory';
    this.pendingQuantity = new Map(); // item id → requests in flight
    this.rows = []; // { kind: 'item', item } | { kind: 'empty', slot }
    this.slotBanner = null;
    this.cursor = 0;
    this.selected = new Set();
    this.undoStack = [];
    this.auth = { no_auth: false, has_password: true, authenticated: false };
  }

  async boot() {
    this.search = $('search');
    this.search.value = this.query;
    if (isMobile()) this.search.placeholder = 'Part, A-12, #tag…';
    this.search.addEventListener('input', () => this.setQuery(this.search.value, { keepInput: true }));
    this.search.addEventListener('keydown', (e) => this.searchKey(e));
    $('add-button').append(icon('plus'));
    $('add-button').addEventListener('click', () => this.quickAdd());
    $('fab').append(icon('plus'));
    $('fab').addEventListener('click', () => this.quickAdd());
    $('more-button').append(icon('more'));
    $('more-button').addEventListener('click', (e) => this.openMoreMenu(e.currentTarget));
    $('brand').prepend(icon('brandLogo'));
    $('search-icon').append(icon('search'));
    $('status-help').addEventListener('click', () => openHelp());
    $('tab-inventory').addEventListener('click', () => this.setView('inventory'));
    $('tab-shopping').addEventListener('click', () => this.setView('shopping'));
    onUnauthorized(() => this.showLogin());
    initKeys(this);

    let status;
    try {
      status = await api.auth.status();
    } catch (err) {
      return this.showFatal(err);
    }
    this.auth = status;
    if (!status.no_auth && !status.has_password) return this.showSetup();
    if (!status.authenticated) return this.showLogin();
    await this.load();
    if (!isMobile()) this.search.focus();
  }

  async load() {
    try {
      this.setInventory(await api.inventory());
    } catch (err) {
      this.report(err);
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Replaces the local copy of the inventory and redraws, keeping the cursor on the same item. */
  setInventory({ items, boxes }) {
    const cursorId = this.cursorItem()?.id;
    this.items = items;
    this.boxes = boxes;
    this.index = items.map(indexItem);
    this.byId = new Map(items.map((it) => [it.id, it]));
    this.slotMap = new Map();
    this.tagCounts = new Map();
    for (const it of items) {
      for (const s of it.slots) {
        if (!this.slotMap.has(s)) this.slotMap.set(s, []);
        this.slotMap.get(s).push(it);
      }
      const withParents = new Set();
      for (const tag of it.tags) {
        const parts = tag.split('/');
        for (let i = 1; i <= parts.length; i++) withParents.add(parts.slice(0, i).join('/'));
      }
      for (const t of withParents) this.tagCounts.set(t, (this.tagCounts.get(t) || 0) + 1);
    }
    this.knownBoxes = new Set(boxes.map((b) => b.id));
    for (const id of [...this.selected]) if (!this.byId.has(id)) this.selected.delete(id);
    this.runSearch();
    const i = cursorId ? this.rows.findIndex((r) => r.item?.id === cursorId) : -1;
    if (i >= 0) this.cursor = i;
    this.render();
  }

  /** Applies a change that answered with one item, without reloading everything. */
  putItem(item) {
    const items = this.byId.has(item.id)
      ? this.items.map((it) => (it.id === item.id ? item : it))
      : [...this.items, item];
    items.sort(itemOrder);
    const boxes = [...this.boxes];
    for (const s of item.slots) {
      const box = parseSlot(s)?.box;
      if (box && !boxes.some((b) => b.id === box)) boxes.push({ id: box, slots: 0, columns: 0 });
    }
    boxes.sort((a, b) => a.id.localeCompare(b.id));
    this.setInventory({ items, boxes });
  }

  setQuery(query, { keepInput = false } = {}) {
    this.query = query;
    if (!keepInput) this.search.value = query;
    this.syncURL();
    this.runSearch();
    this.cursor = 0;
    this.render();
  }

  setView(view) {
    if (view === this.view) return;
    this.view = view;
    this.selected.clear();
    this.syncURL();
    this.runSearch();
    this.cursor = 0;
    this.render();
  }

  /** Keeps the search and the tab in the URL, so they survive a reload and can be bookmarked. */
  syncURL() {
    const url = new URL(location.href);
    if (this.query) url.searchParams.set('q', this.query);
    else url.searchParams.delete('q');
    if (this.view === 'shopping') url.searchParams.set('view', 'shopping');
    else url.searchParams.delete('view');
    history.replaceState(null, '', url);
  }

  runSearch() {
    const q = parseQuery(this.query);
    this.slotBanner = null;
    if (this.view === 'shopping') {
      this.rows = search(this.index, q).hits
        .filter((hit) => hit.item.to_buy)
        .map((hit) => ({ kind: 'item', item: hit.item }));
      return;
    }
    if (q.flags.includes('empty')) {
      this.rows = this.emptySlots(q.boxes).map((slot) => ({ kind: 'empty', slot }));
      return;
    }
    const { slot, hits } = search(this.index, q);
    this.rows = hits.map((hit) => ({ kind: 'item', item: hit.item, inSlot: hit.inSlot }));
    // "M3" parses as a slot, but only means one when box M exists or the dash was typed.
    if (slot && (this.knownBoxes.has(parseSlot(slot).box) || /-/.test(this.query))) {
      this.slotBanner = { slot, count: (this.slotMap.get(slot) || []).length };
    }
  }

  /** Free slots of the configured boxes (optionally only some boxes). */
  emptySlots(boxIds = []) {
    const out = [];
    for (const b of this.boxes) {
      if (!b.slots || (boxIds.length && !boxIds.includes(b.id))) continue;
      for (let n = 1; n <= b.slots; n++) {
        const s = slotName({ box: b.id, number: n });
        if (!this.slotMap.has(s)) out.push(s);
      }
    }
    return out;
  }

  cursorRow() {
    return this.rows[this.cursor] || null;
  }

  cursorItem() {
    const row = this.cursorRow();
    return row?.kind === 'item' ? row.item : null;
  }

  /** The items an action applies to: the selection, or the item under the cursor. */
  targets() {
    if (this.selected.size) return this.items.filter((it) => this.selected.has(it.id));
    const it = this.cursorItem();
    return it ? [it] : [];
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render() {
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
    this.renderList();
    this.renderPreview();
    this.renderStatus();
  }

  renderList() {
    const list = clear($('results'));
    const terms = parseQuery(this.query).terms;
    if (this.slotBanner) {
      const { slot, count } = this.slotBanner;
      list.append(h('div', { class: 'slot-banner' },
        h('span', { class: 'slot' }, slot),
        h('span', null, count ? `${count} item${count === 1 ? '' : 's'}` : 'empty'),
        count ? null : h('button', { type: 'button', class: 'button', onclick: () => this.quickAdd(`${slot} `) }, h('kbd', null, 'a'), 'add here')));
    }
    if (!this.rows.length && this.view === 'shopping') {
      list.append(h('div', { class: 'empty-state' }, this.query
        ? 'no match in the shopping list'
        : h('span', null, 'nothing to buy. an item lands here when its quantity drops to 0 (', h('kbd', null, '-'), ').')));
      return;
    }
    if (!this.rows.length) {
      list.append(h('div', { class: 'empty-state' }, this.items.length
        ? (this.slotBanner ? null : 'no match. try fewer words, a tag (#…) or a box (@A).')
        : h('span', null, 'inventory is empty. press ', h('kbd', null, 'a'), ' to add a part.')));
      return;
    }
    list.append(h('div', { class: 'row thead', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'row-mark' }), h('span', null, 'slot'), h('span', { class: 'num' }, 'qty'),
      h('span', null, 'name'), h('span', null, 'tags')));
    this.rows.slice(0, MAX_ROWS).forEach((row, i) => list.append(this.renderRow(row, i, terms)));
    if (this.rows.length > MAX_ROWS) {
      list.append(h('div', { class: 'more-rows' }, `${this.rows.length - MAX_ROWS} more rows: refine the search`));
    }
    list.querySelector('.row.cursor')?.scrollIntoView({ block: 'nearest' });
  }

  renderRow(row, i, terms) {
    const onclick = () => {
      this.cursor = i;
      this.render();
      if (isMobile()) this.openPreviewSheet();
    };
    if (row.kind === 'empty') {
      return h('div', { class: ['row', 'row-empty', i === this.cursor && 'cursor'], onclick, ondblclick: () => this.quickAdd(`${row.slot} `) },
        h('span', { class: 'row-mark' }),
        h('span', { class: 'row-slot' }, row.slot),
        h('span', { class: 'row-qty num' }, ''),
        h('span', { class: 'row-name' }, '(empty)'),
        h('span', { class: 'row-tags' }));
    }
    const it = row.item;
    return h('div', {
      class: ['row', i === this.cursor && 'cursor', this.selected.has(it.id) && 'selected', row.inSlot && 'in-slot'],
      dataset: { id: it.id },
      onclick,
      ondblclick: () => this.edit(it),
    },
    h('span', { class: 'row-mark' }),
    h('span', { class: ['row-slot', !it.slots.length && 'none'], title: it.slots.join(' ') },
      it.slots[0] || '—', it.slots.length > 1 ? h('span', { class: 'more' }, ` +${it.slots.length - 1}`) : null),
    h('span', { class: ['row-qty', 'num', quantityClass(it)] }, String(it.quantity)),
    highlighted('row-name', it.name, terms),
    h('span', { class: 'row-tags' }, it.tags.join(' ')));
  }

  renderPreview() {
    const pane = clear($('preview'));
    pane.append(this.previewContent());
  }

  /** The details of the cursor row, as a key/value sheet, for the side pane or the phone sheet. */
  previewContent() {
    const row = this.cursorRow();
    if (!row) return h('div', { class: 'preview-empty' }, this.items.length ? 'no item selected' : '');
    const field = (key, ...value) => [h('dt', null, key), h('dd', null, ...value)];
    const action = (key, label, run, className) => h('button', { type: 'button', class: ['button', className], onclick: run }, h('kbd', null, key), label);
    if (row.kind === 'empty') {
      return h('div', { class: 'preview-body' },
        h('h2', { class: 'preview-title' }, row.slot),
        h('dl', { class: 'sheet' }, field('status', h('span', { class: 'muted' }, 'empty'))),
        h('div', { class: 'preview-actions' }, action('a', 'add here', () => this.quickAdd(`${row.slot} `))),
        this.neighbours(row.slot));
    }
    const it = row.item;
    const link = (text, query, className) => h('button', { type: 'button', class: ['link-button', className], onclick: () => { closeAllModals(); this.setQuery(query); } }, text);
    const date = (iso) => (iso || '').slice(0, 10);
    return h('div', { class: 'preview-body' },
      h('h2', { class: 'preview-title' }, it.name),
      h('dl', { class: 'sheet' },
        field('slot', it.slots.length ? it.slots.map((sl) => link(sl, sl, 'slot')) : h('span', { class: 'muted' }, 'none')),
        field('qty', this.quantityControl(it)),
        it.tags.length ? field('tags', it.tags.map((t) => link(t, `#${t}`, 'tag'))) : null,
        it.aliases.length ? field('aka', h('span', { class: 'alias' }, it.aliases.join(', '))) : null,
        it.description ? field('desc', h('span', { class: 'text' }, it.description)) : null,
        it.notes ? field('notes', h('span', { class: 'text' }, it.notes)) : null,
        field('updated', h('span', { class: 'muted' }, date(it.updated_at)))),
      it.to_buy ? h('div', { class: 'preview-actions shopping-actions' },
        action('x', 'bought: set qty', () => this.setQuantity(it), 'primary'),
        action('d', 'won’t buy: delete', () => this.remove([it]), 'danger-text')) : null,
      h('div', { class: 'preview-actions' },
        action('e', 'edit', () => this.edit(it)),
        action('m', 'move', () => this.moveTargets([it])),
        action('s', 'swap', () => this.swap(it.slots[0])),
        action('d', 'delete', () => this.remove([it]), 'danger-text')),
      it.slots[0] ? this.neighbours(it.slots[0], it) : null);
  }

  /** [−] 12 [+]: the number itself opens a field to type it. */
  quantityControl(it) {
    return h('span', { class: ['quantity-control', quantityClass(it)] },
      h('button', { type: 'button', class: 'qty-step', title: 'One less (-)', disabled: it.quantity === 0, onclick: () => this.changeQuantity(it, -1) }, '−'),
      h('button', { type: 'button', class: 'qty-value', title: 'Set the quantity (x)', onclick: () => this.setQuantity(it) }, String(it.quantity)),
      h('button', { type: 'button', class: 'qty-step', title: 'One more (+)', onclick: () => this.changeQuantity(it, 1) }, '+'),
      it.to_buy ? h('span', { class: 'qty-note' }, 'to buy') : null);
  }

  /** What else is in the slot, and what sits next to it. */
  neighbours(slot, self = null) {
    const s = parseSlot(slot);
    const others = (this.slotMap.get(slot) || []).filter((it) => it !== self);
    const line = (target, label, onclick) => h('button', { type: 'button', class: 'neighbour', onclick },
      h('span', { class: 'slot' }, target), h('span', { class: ['neighbour-label', label === 'empty' && 'muted'] }, label));
    const config = this.boxes.find((b) => b.id === s.box);
    const around = [s.number - 1, s.number + 1]
      .filter((n) => n >= 1 && (!config?.slots || n <= config.slots))
      .map((n) => slotName({ box: s.box, number: n }));
    const open = (target) => () => { closeAllModals(); this.setQuery(target); };
    return h('section', { class: 'preview-section' },
      h('h3', null, 'neighbours'),
      others.map((it) => line(slot, it.name, () => this.focusItem(it))),
      around.map((n) => line(n, slotSummary(this, n), open(n))));
  }

  openPreviewSheet() {
    if (!this.cursorRow()) return;
    openModal({ className: 'preview-sheet', body: this.previewContent(), autofocus: false });
  }

  renderStatus(mode) {
    const insert = mode ? mode === 'INSERT' : document.activeElement === this.search;
    const el = $('status-mode');
    el.textContent = insert ? '-- SEARCH --' : '-- NORMAL --';
    el.className = `status-mode ${insert ? 'insert' : 'normal'}`;
    const total = this.rows.length;
    $('status-position').textContent = `${total ? this.cursor + 1 : 0} / ${total}`;
    const toBuy = this.items.filter((it) => it.to_buy).length;
    $('result-count').textContent = `${total}/${this.view === 'shopping' ? toBuy : this.items.length}`;
    $('tab-inventory').classList.toggle('active', this.view === 'inventory');
    $('tab-shopping').classList.toggle('active', this.view === 'shopping');
    $('shopping-count').textContent = String(toBuy);
    $('shopping-count').classList.toggle('alert', toBuy > 0);
    $('status-selection').textContent = this.selected.size ? `${this.selected.size} selected` : '';
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  searchKey(e) {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'ArrowDown' || (ctrl && (e.key === 'j' || e.key === 'n'))) {
      e.preventDefault();
      this.moveCursor(1);
    } else if (e.key === 'ArrowUp' || (ctrl && (e.key === 'k' || e.key === 'p'))) {
      e.preventDefault();
      this.moveCursor(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.search.blur();
      if (isMobile()) this.openPreviewSheet();
    }
  }

  moveCursor(delta) {
    if (!this.rows.length) return;
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
    this.render();
  }

  moveCursorTo(i) {
    this.cursor = i < 0 ? this.rows.length - 1 : i;
    this.render();
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  /** Shows one item: clears the search if it hides it. */
  focusItem(item) {
    closeAllModals();
    let i = this.rows.findIndex((r) => r.item?.id === item.id);
    if (i < 0) {
      this.setQuery('');
      i = this.rows.findIndex((r) => r.item?.id === item.id);
    }
    this.cursor = Math.max(0, i);
    this.render();
  }

  toggleSelection() {
    const it = this.cursorItem();
    if (!it) return;
    if (this.selected.has(it.id)) this.selected.delete(it.id);
    else this.selected.add(it.id);
    this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
    this.render();
  }

  escape() {
    if (this.selected.size) {
      this.selected.clear();
      this.render();
    } else if (this.query) {
      this.setQuery('');
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Runs an API call; on failure shows the error and returns undefined. */
  async run(fn) {
    try {
      return await fn();
    } catch (err) {
      this.report(err);
      return undefined;
    }
  }

  report(err) {
    if (err instanceof ApiError && err.status === 401) return; // the login dialog is shown
    toast(err.message, { type: 'error' });
  }

  /** Records how to undo the last change and offers it in a toast. */
  done(message, undo) {
    if (undo) this.undoStack.push({ message, undo });
    if (this.undoStack.length > 50) this.undoStack.shift();
    toast(message, { type: 'success', action: undo ? { label: 'Undo', run: () => this.undo() } : null });
  }

  async undo() {
    const entry = this.undoStack.pop();
    if (!entry) return toast('Nothing to undo');
    const data = await this.run(entry.undo);
    if (data?.items && data?.boxes) this.setInventory(data);
    else if (data !== undefined) await this.load();
    if (data !== undefined) toast(`Undone: ${entry.message}`);
  }

  /** Undo for an edit: put back copies of the items as they are now. */
  snapshot(items) {
    const copies = structuredClone(items);
    return () => api.items.restore(copies);
  }

  quickAdd(prefill = '') {
    const row = this.cursorRow();
    if (!prefill && row?.kind === 'empty') prefill = `${row.slot} `;
    if (!prefill && this.slotBanner && !this.slotBanner.count) prefill = `${this.slotBanner.slot} `;
    openQuickAdd(this, { prefill });
  }

  edit(item = this.cursorItem()) {
    if (item) openEditor(this, item);
  }

  async moveTargets(items = this.targets()) {
    if (!items.length) return;
    const title = items.length === 1 ? `Move “${items[0].name}” to…` : `Move ${items.length} items to…`;
    const slot = await pickSlot(this, { title, okText: 'Move' });
    if (!slot) return;
    const undo = this.snapshot(items);
    const data = await this.run(() => api.items.move(items.map((it) => it.id), slot));
    if (!data) return;
    this.selected.clear();
    this.setInventory(data);
    this.done(items.length === 1 ? `Moved “${items[0].name}” to ${slot}` : `Moved ${items.length} items to ${slot}`, undo);
  }

  async swap(from = this.cursorItem()?.slots[0] || (this.cursorRow()?.kind === 'empty' ? this.cursorRow().slot : '')) {
    const pair = await openSwap(this, from || '');
    if (pair) await this.swapSlots(pair[0], pair[1]);
  }

  async swapSlots(a, b) {
    const data = await this.run(() => api.swapSlots(a, b));
    if (!data) return;
    this.setInventory(data);
    this.done(`Swapped ${a} and ${b}`, () => api.swapSlots(a, b));
  }

  async tagTargets(items = this.targets()) {
    if (!items.length) return;
    const change = await openTagDialog(this, items);
    if (!change || (!change.add.length && !change.remove.length)) return;
    const undo = this.snapshot(items);
    const data = await this.run(() => api.items.tag(items.map((it) => it.id), change.add, change.remove));
    if (!data) return;
    this.setInventory(data);
    this.done(`Tags updated on ${items.length} item${items.length === 1 ? '' : 's'}`, undo);
  }

  /**
   * Adds delta to the quantity, showing it at once. The server applies the
   * same delta in a transaction; its answer is shown once no other change is
   * pending.
   */
  async changeQuantity(item = this.cursorItem(), delta = 1) {
    if (!item) return;
    item = this.byId.get(item.id) || item;
    const after = Math.max(0, item.quantity + delta);
    if (after === item.quantity) return;
    const undo = this.snapshot([item]);
    this.pendingQuantity.set(item.id, (this.pendingQuantity.get(item.id) || 0) + 1);
    this.putItem({ ...item, quantity: after, to_buy: shoppingFlag(item, after) });
    let updated;
    try {
      updated = await api.items.quantity(item.id, { delta });
    } catch (err) {
      this.report(err);
    }
    const pending = this.pendingQuantity.get(item.id) - 1;
    if (pending) this.pendingQuantity.set(item.id, pending);
    else this.pendingQuantity.delete(item.id);
    if (!updated) return this.load();
    if (!pending) this.putItem(updated);
    this.quantityChanged(item, updated, undo);
  }

  async setQuantity(item = this.cursorItem()) {
    if (!item) return;
    const value = await openQuantityDialog(item);
    if (value === null || value === item.quantity) return;
    const undo = this.snapshot([item]);
    const updated = await this.run(() => api.items.quantity(item.id, { set: value }));
    if (!updated) return;
    this.putItem(updated);
    this.quantityChanged(item, updated, undo);
  }

  /** Records the undo, and tells when an item joins or leaves the shopping list. */
  quantityChanged(before, item, undo) {
    if (item.to_buy && !before.to_buy) {
      this.done(`${item.name}: 0 left, added to the shopping list`, undo);
    } else if (before.to_buy && !item.to_buy) {
      this.done(`${item.name}: restocked (${item.quantity})`, undo);
    } else {
      this.undoStack.push({ message: `quantity of ${item.name}`, undo });
    }
  }

  async remove(items = this.targets()) {
    if (!items.length) return;
    const res = await this.run(() => api.items.remove(items.map((it) => it.id)));
    if (!res) return;
    closeAllModals();
    for (const it of items) this.selected.delete(it.id);
    await this.load();
    const removed = res.items;
    this.done(removed.length === 1 ? `Deleted “${removed[0].name}”` : `Deleted ${removed.length} items`, () => api.items.restore(removed));
  }

  openMoreMenu(anchor) {
    openMenu(anchor, [
      { label: 'Boxes', icon: 'grid', hint: 'b', run: () => this.openGrid() },
      { label: 'Tags', icon: 'tag', hint: 'T', run: () => openTags(this) },
      'separator',
      { label: 'Import CSV…', icon: 'upload', run: () => this.importCSV() },
      { label: 'Export CSV', icon: 'download', run: () => this.exportCSV() },
      'separator',
      { label: 'Keyboard shortcuts', icon: 'help', hint: '?', run: () => openHelp() },
      ...(this.auth.no_auth ? [] : [
        { label: 'Change password', icon: 'key', run: () => this.changePassword() },
        { label: 'Lock', icon: 'lock', run: () => this.lock() },
      ]),
    ]);
  }

  openGrid(boxId) {
    const row = this.cursorRow();
    const slot = row?.kind === 'empty' ? row.slot : row?.item?.slots[0] || this.slotBanner?.slot;
    openGrid(this, boxId || (slot && parseSlot(slot).box), slot);
  }

  async exportCSV() {
    const res = await this.run(() => api.exportCSV());
    if (!res) return;
    const url = URL.createObjectURL(res.blob);
    const a = h('a', { href: url, download: res.filename });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  importCSV() {
    const input = h('input', { type: 'file', accept: '.csv,text/csv' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const res = await this.run(() => api.importCSV(file));
      if (!res) return;
      await this.load();
      toast(`Imported: ${res.created} new, ${res.merged} merged into existing items`, { type: 'success' });
    });
    input.click();
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  passwordForm({ title, intro, fields, submitLabel, dismissible, onSubmit }) {
    const error = h('div', { class: 'form-error', hidden: true });
    const inputs = fields.map((f) => h('input', {
      type: 'password', class: 'input', placeholder: f.placeholder, autocomplete: f.autocomplete, attrs: { 'aria-label': f.label },
    }));
    const submit = h('button', { type: 'submit', class: 'button primary wide' }, submitLabel);
    const form = h('form', { class: 'auth-form' },
      intro ? h('p', { class: 'dialog-message' }, intro) : null,
      error,
      fields.map((f, i) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label), inputs[i])),
      submit);
    let modal;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const message = await onSubmit(inputs.map((i) => i.value));
        if (message) {
          error.textContent = message;
          error.hidden = false;
        } else {
          modal.close();
        }
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    modal = openModal({ title, body: form, className: 'dialog auth', dismissible });
    return modal;
  }

  showSetup() {
    closeAllModals({ keepUndismissible: false });
    this.passwordForm({
      title: 'Welcome to Inventory',
      intro: 'Choose a master password to protect this instance. You can change it later.',
      fields: [
        { label: 'Master password', placeholder: 'At least 4 characters', autocomplete: 'new-password' },
        { label: 'Confirm password', placeholder: 'Repeat the password', autocomplete: 'new-password' },
      ],
      submitLabel: 'Set password and continue',
      dismissible: false,
      onSubmit: async ([password, confirm]) => {
        if (password.length < 4) return 'The password must be at least 4 characters long.';
        if (password !== confirm) return 'The passwords do not match.';
        await api.auth.setup(password);
        this.afterLogin();
        return null;
      },
    });
  }

  showLogin() {
    if (topModal()?.el.classList.contains('auth')) return;
    closeAllModals({ keepUndismissible: false });
    this.auth.authenticated = false;
    this.passwordForm({
      title: 'Inventory is locked',
      intro: 'Enter your master password to unlock.',
      fields: [{ label: 'Password', placeholder: 'Master password', autocomplete: 'current-password' }],
      submitLabel: 'Unlock',
      dismissible: false,
      onSubmit: async ([password]) => {
        if (!password) return 'Enter your password.';
        await api.auth.login(password);
        this.afterLogin();
        return null;
      },
    });
  }

  async afterLogin() {
    this.auth = { ...this.auth, has_password: true, authenticated: true };
    await this.load();
    if (!isMobile()) this.search.focus();
  }

  changePassword() {
    this.passwordForm({
      title: 'Change password',
      fields: [
        { label: 'Current password', placeholder: 'Current master password', autocomplete: 'current-password' },
        { label: 'New password', placeholder: 'At least 4 characters', autocomplete: 'new-password' },
        { label: 'Confirm new password', placeholder: 'Repeat the new password', autocomplete: 'new-password' },
      ],
      submitLabel: 'Update password',
      dismissible: true,
      onSubmit: async ([current, next, confirm]) => {
        if (next.length < 4) return 'The new password must be at least 4 characters long.';
        if (next !== confirm) return 'The new passwords do not match.';
        await api.auth.changePassword(current, next);
        toast('Password updated. Other devices were signed out.', { type: 'success' });
        return null;
      },
    });
  }

  async lock() {
    await this.run(() => api.auth.logout());
    this.showLogin();
  }

  showFatal(err) {
    const retry = h('button', { type: 'button', class: 'button primary', onclick: () => location.reload() }, 'Retry');
    openModal({
      title: 'Inventory is unavailable',
      className: 'dialog',
      dismissible: false,
      body: h('p', { class: 'dialog-message' }, err.message),
      footer: retry,
    });
  }
}

/** Same rule as the server: on the list once the quantity drops to 0, off it above 0. */
function shoppingFlag(item, quantity) {
  return quantity === 0 && (item.to_buy || item.quantity > 0);
}

function quantityClass(it) {
  if (it.to_buy) return 'to-buy';
  return it.quantity === 0 ? 'zero' : '';
}

/** A span with the characters matching the search terms wrapped in <mark>. */
function highlighted(className, text, terms) {
  const { chars, marks } = highlight(text, terms);
  const el = h('span', { class: className });
  let run = '';
  let runMarked = false;
  const flush = () => {
    if (run) el.append(runMarked ? h('mark', null, run) : run);
    run = '';
  };
  chars.forEach((c, k) => {
    if (marks[k] !== runMarked) {
      flush();
      runMarked = marks[k];
    }
    run += c;
  });
  flush();
  return el;
}

/** The server's order: by first slot, items without a slot last, then by name. */
function itemOrder(a, b) {
  if (!a.slots.length || !b.slots.length) return (b.slots.length - a.slots.length) || a.name.localeCompare(b.name);
  return compareSlots(a.slots[0], b.slots[0]) || a.name.localeCompare(b.name);
}

const app = new App();
app.boot();
