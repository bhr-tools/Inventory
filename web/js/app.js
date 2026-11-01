// Inventory web app: one fzf-like view. The search field filters the list on
// every keystroke; the pane on the right previews the item under the cursor.

import { api, ApiError, onUnauthorized } from './api.js';
import { h, icon, clear, isMobile } from './dom.js';
import { openModal, openMenu, closeAllModals, topModal, toast } from './ui/overlay.js';
import { parseQuery, indexItem, search, highlight } from './search.js';
import { parseSlot, slotName, compareSlots } from './slots.js';
import { slotSummary } from './suggest.js';
import { formatPrice } from './text.js';
import { initKeys } from './keys.js';
import { openSwap, openTagDialog, openQuantityDialog } from './views/dialogs.js';
import { openGrid } from './views/grid.js';
import { openTags } from './views/tags.js';
import { openHelp } from './views/help.js';
import { filesSection, uploadFiles } from './views/files.js';
import { openItemForm } from './views/itemform.js';
import { openSlotMap } from './views/slotmap.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 300;
const VIEWS = ['parts', 'gear', 'shopping']; // rendered at once; the count shows the rest

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
    // 'parts', 'gear' (the register of valuables), or 'shopping': the parts whose quantity dropped to 0.
    // ?view=tools is the address of the gear tab before it was renamed.
    const view = params.get('view') === 'tools' ? 'gear' : params.get('view');
    this.view = VIEWS.includes(view) ? view : 'parts';
    // Gear tab: the archived gear (broken, lost, sold) instead of what is in use.
    this.archived = this.view === 'gear' && params.get('archived') === '1';
    // { view, count } or { archived, count }: matches elsewhere, when this list has none.
    this.elsewhere = null;
    this.grouped = false; // box headings over the parts, type headings over the gear (no words searched)
    this.editingQty = null; // item id whose quantity is being typed in the details
    this.pendingQuantity = new Map(); // item id → requests in flight
    this.sheet = null; // phones: the full-screen details, { modal, body, row }
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
    this.search.addEventListener('input', () => this.setQuery(this.search.value, { keepInput: true }));
    this.search.addEventListener('keydown', (e) => this.searchKey(e));
    $('search-clear').addEventListener('click', () => {
      this.setQuery('');
      this.search.focus();
    });
    $('add-button').addEventListener('click', () => this.add());
    $('tab-add').addEventListener('click', () => this.add());
    $('more-button').append(icon('more'));
    $('more-button').addEventListener('click', (e) => this.openMoreMenu(e.currentTarget));
    $('status-help').addEventListener('click', () => openHelp());
    for (const v of VIEWS) {
      $(`tab-${v}`).addEventListener('click', () => (v === 'gear' && this.archived ? this.setArchived(false) : this.setView(v)));
    }
    this.initDrop();
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
    this.archived = false;
    this.selected.clear();
    this.syncURL();
    this.runSearch();
    this.cursor = 0;
    this.render();
  }

  /** Gear tab: shows the archived gear, or what is in use. */
  setArchived(on) {
    this.view = 'gear';
    this.archived = on;
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
    if (this.view !== 'parts') url.searchParams.set('view', this.view);
    else url.searchParams.delete('view');
    if (this.archived) url.searchParams.set('archived', '1');
    else url.searchParams.delete('archived');
    history.replaceState(null, '', url);
  }

  runSearch() {
    const q = parseQuery(this.query);
    this.slotBanner = null;
    this.elsewhere = null;
    this.grouped = this.view !== 'shopping' && !q.terms.length;
    if (this.view === 'shopping') {
      this.rows = search(this.index, q).hits
        .filter((hit) => hit.item.to_buy)
        .map((hit) => ({ kind: 'item', item: hit.item }));
      return;
    }
    if (this.view === 'parts' && q.flags.includes('empty')) {
      this.rows = this.emptySlots(q.boxes).map((slot) => ({ kind: 'empty', slot }));
      return;
    }
    const { slot, hits } = search(this.index, q);
    const kind = this.view === 'gear' ? 'gear' : 'part';
    // Archived gear only shows in its own list, or when asked for (is:archived).
    const archived = kind === 'gear' && (this.archived || q.flags.includes('archived'));
    const shown = (it) => itemKind(it) === kind && (kind === 'part' || isArchived(it) === archived);
    this.rows = hits.filter((hit) => shown(hit.item))
      .map((hit) => ({ kind: 'item', item: hit.item, inSlot: hit.inSlot }));
    // Nothing here but something in the other list: say so rather than "no match".
    if (!this.rows.length && this.query.trim()) {
      const other = hits.filter((hit) => itemKind(hit.item) === 'gear' && isArchived(hit.item) !== archived).length;
      const count = hits.filter((hit) => itemKind(hit.item) !== kind).length;
      if (kind === 'gear' && other) this.elsewhere = { archived: !archived, count: other };
      else if (count) this.elsewhere = { view: kind === 'gear' ? 'parts' : 'gear', count };
    }
    if (kind === 'gear') {
      // Without words, the gear comes by type (untyped last), then by name.
      if (this.grouped) this.rows.sort((a, b) => compareTypes(a.item, b.item) || a.item.name.localeCompare(b.item.name));
      return;
    }
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
    if (this.view === 'gear' && this.archived) {
      list.append(h('div', { class: 'archive-banner' },
        h('p', null, h('strong', null, 'Archived gear'), 'Broken, lost or sold: kept with its serial number and files.'),
        h('button', { type: 'button', class: 'button', onclick: () => this.setArchived(false) }, '← Gear in use')));
    }
    if (this.slotBanner) {
      const { slot, count } = this.slotBanner;
      list.append(h('div', { class: 'slot-banner' },
        h('span', { class: 'slot' }, slot),
        h('span', null, count ? `${count} item${count === 1 ? '' : 's'}` : 'empty'),
        count ? null : h('button', { type: 'button', class: 'button', onclick: () => this.add({ slot }) }, h('kbd', null, 'a'), 'add here')));
    }
    if (!this.rows.length && this.view === 'shopping') {
      list.append(h('div', { class: 'empty-state' }, this.query
        ? 'No match in the shopping list.'
        : 'Nothing to buy. A part lands here when its quantity drops to 0.'));
      return;
    }
    if (!this.rows.length && this.elsewhere) {
      const { view, archived, count } = this.elsewhere;
      const here = this.view === 'gear' ? (this.archived ? 'the archive' : 'gear in use') : this.view;
      list.append(h('div', { class: 'empty-state' }, `No match in ${here}. `,
        view
          ? h('button', { type: 'button', class: 'link-button', onclick: () => this.setView(view) }, `${count} in ${view} →`)
          : h('button', { type: 'button', class: 'link-button', onclick: () => this.setArchived(archived) },
            `${count} ${archived ? 'archived' : 'in use'} →`)));
      return;
    }
    if (!this.rows.length) {
      const gear = this.view === 'gear';
      const anyOfKind = this.items.some((it) => itemKind(it) === (gear ? 'gear' : 'part') && (!gear || isArchived(it) === this.archived));
      let text;
      if (anyOfKind) text = this.slotBanner ? null : `No match. Try fewer words, a tag (#…)${gear ? ', a type or a serial number' : ' or a box (@A)'}.`;
      else if (gear && this.archived) text = 'No archived gear. Archive an item from its details when it is broken, lost or sold.';
      else text = gear ? 'No gear yet: tools, a watch, a laptop… Add one with + Add.' : 'No part yet. Add one with + Add.';
      list.append(h('div', { class: 'empty-state' }, text,
        this.query.trim() && !this.slotBanner && !(gear && this.archived)
          ? [' ', h('button', { type: 'button', class: 'link-button', onclick: () => this.add({ name: this.query.trim() }) }, `Add “${this.query.trim()}”`)]
          : null));
      this.archivedNote(list);
      return;
    }
    list.append(this.view === 'gear'
      ? h('div', { class: 'row gear-row thead', attrs: { 'aria-hidden': 'true' } },
        h('span', { class: 'row-mark' }), h('span', null, 'Item'), h('span', null, 'Brand · reference'),
        h('span', null, 'Serial no.'), h('span', { class: 'num' }, 'Docs'))
      : h('div', { class: 'row thead', attrs: { 'aria-hidden': 'true' } },
        h('span', { class: 'row-mark' }), h('span', null, 'Slot'), h('span', null, 'Description'),
        h('span', null, 'Tags'), h('span', { class: 'num' }, 'Qty')));
    let group;
    this.rows.slice(0, MAX_ROWS).forEach((row, i) => {
      if (this.grouped && this.view === 'gear') {
        const type = row.item.type || '';
        if (type !== group) list.append(this.typeHead((group = type)));
      } else if (this.grouped) {
        const b = parseSlot(row.kind === 'empty' ? row.slot : row.item.slots[0] || '')?.box || '';
        if (b !== group) list.append(this.boxHead((group = b)));
      }
      list.append(this.renderRow(row, i, terms));
    });
    if (this.rows.length > MAX_ROWS) {
      list.append(h('div', { class: 'more-rows' }, `${this.rows.length - MAX_ROWS} more rows: refine the search`));
    }
    this.archivedNote(list);
    list.querySelector('.row.cursor')?.scrollIntoView({ block: 'nearest' });
  }

  /** Under the gear in use: how much is archived, and the way to it. */
  archivedNote(list) {
    if (this.view !== 'gear' || this.archived || this.query.trim()) return;
    const count = this.items.filter(isArchived).length;
    if (!count) return;
    list.append(h('div', { class: 'list-note' },
      h('span', null, `${count} archived item${count === 1 ? '' : 's'} hidden: broken, lost or sold.`),
      h('button', { type: 'button', class: 'button', onclick: () => this.setArchived(true) }, 'Show archived')));
  }

  /** "WATCH — 2" above the gear of one type. */
  typeHead(type) {
    const count = this.rows.filter((r) => (r.item.type || '') === type).length;
    return h('div', { class: 'box-head' },
      h('span', null, type || 'No type'),
      h('span', { class: 'box-meta' }, String(count)));
  }

  /** "BOX A — 24 slots · 15 free" above the parts of a box. */
  boxHead(box) {
    if (!box) return h('div', { class: 'box-head' }, h('span', null, 'No slot'));
    const config = this.boxes.find((b) => b.id === box);
    const used = [...this.slotMap.keys()].filter((s) => parseSlot(s)?.box === box).length;
    return h('div', { class: 'box-head' },
      h('span', null, `Box ${box}`),
      h('span', { class: 'box-meta' }, config?.slots ? `${config.slots} slots · ${Math.max(0, config.slots - used)} free` : `${used} used`));
  }

  renderRow(row, i, terms) {
    const onclick = () => {
      this.cursor = i;
      this.render();
      if (isMobile()) this.openPreviewSheet();
    };
    if (row.kind === 'empty') {
      return h('div', { class: ['row', 'row-empty', i === this.cursor && 'cursor'], onclick, ondblclick: () => this.add({ slot: row.slot }) },
        h('span', { class: 'row-mark' }),
        h('span', { class: 'row-slot' }, row.slot),
        h('span', { class: 'row-name' }, '(empty)'),
        h('span', { class: 'row-tags' }),
        h('span', { class: 'row-qty num' }, ''));
    }
    const it = row.item;
    if (itemKind(it) === 'gear') {
      const ref = [it.brand, it.model].filter(Boolean).join(' ');
      const files = it.attachments?.length || 0;
      return h('div', {
        class: ['row', 'gear-row', i === this.cursor && 'cursor', this.selected.has(it.id) && 'selected'],
        dataset: { id: it.id },
        onclick,
        ondblclick: () => this.edit(it),
      },
      h('span', { class: 'row-mark' }),
      h('span', { class: 'row-name-cell' },
        // Under a type heading the type goes without saying; in search results it is shown.
        h('span', { class: 'row-name-line' }, highlighted('row-name', it.name, terms),
          !this.grouped && it.type ? h('span', { class: 'row-type' }, it.type) : null),
        // Phones show one column: the reference and the documents go under the name.
        h('span', { class: 'row-sub' }, [ref, files ? `${files} doc${files === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '—')),
      h('span', { class: 'row-brand' }, ref || '—'),
      h('span', { class: 'row-serial' }, it.serial || '—'),
      h('span', { class: ['row-files', 'num', !files && 'none'] }, files ? String(files) : '—'));
    }
    return h('div', {
      class: ['row', i === this.cursor && 'cursor', this.selected.has(it.id) && 'selected', row.inSlot && 'in-slot'],
      dataset: { id: it.id },
      onclick,
      ondblclick: () => this.edit(it),
    },
    h('span', { class: 'row-mark' }),
    h('span', { class: ['row-slot', !it.slots.length && 'none'], title: it.slots.join(' ') },
      it.slots[0] || '—', it.slots.length > 1 ? h('span', { class: 'more' }, ` +${it.slots.length - 1}`) : null),
    highlighted('row-name', it.name, terms),
    h('span', { class: 'row-tags' }, it.tags.join(' ')),
    h('span', { class: ['row-qty', 'num', quantityClass(it)] }, String(it.quantity)));
  }

  renderPreview() {
    const pane = clear($('preview'));
    pane.append(this.previewContent());
    this.renderSheet();
  }

  /**
   * The details of the cursor row as a datasheet (kicker, name, stock,
   * specification, documents, actions), for the side pane or the phone page.
   */
  previewContent(row = this.cursorRow()) {
    if (!row) return h('div', { class: 'preview-empty' }, this.items.length ? 'Nothing selected.' : '');
    const action = (key, label, run, className) => h('button', { type: 'button', class: ['button', className], onclick: run }, h('kbd', null, key), label);
    const section = (title, aside, ...content) => h('section', { class: 'ds-section' },
      h('h3', { class: 'ds-head' }, h('span', null, title), aside ? h('span', { class: 'aside' }, aside) : null),
      ...content);
    const pair = (key, value, extra = null) => [
      h('dt', null, key),
      h('dd', { class: extra ? null : 'wide' }, value),
      extra ? h('dd', { class: 'spec-action' }, extra) : null,
    ];
    const none = () => h('span', { class: 'muted' }, '—');
    if (row.kind === 'empty') {
      return h('div', { class: 'preview-body' },
        h('div', { class: 'kicker' }, h('span', null, 'Slot'), h('span', { class: 'state' }, '○ free')),
        h('h2', { class: 'preview-title' }, row.slot),
        h('div', { class: 'preview-actions' }, action('a', 'add here', () => this.add({ slot: row.slot }), 'primary')),
        this.neighbours(row.slot));
    }
    const it = row.item;
    const link = (text, query, className) => h('button', { type: 'button', class: ['link-button', className], onclick: () => { closeAllModals(); this.setQuery(query); } }, text);
    const common = [
      it.tags.length ? pair('Tags', it.tags.map((t) => link(t, `#${t}`, 'tag'))) : null,
      it.aliases.length ? pair('Also known as', h('span', { class: 'alias' }, it.aliases.join(', '))) : null,
      it.description ? pair('Description', h('span', { class: 'text' }, it.description)) : null,
      it.notes ? pair('Notes', h('span', { class: 'text' }, it.notes)) : null,
      pair('Updated', h('span', { class: 'muted mono' }, (it.updated_at || '').slice(0, 10))),
    ];
    const kicker = (kind, state, className) => h('div', { class: 'kicker' },
      h('span', null, [kind, it.tags[0]].filter(Boolean).join(' · ')),
      h('span', { class: ['state', className] }, state));

    if (itemKind(it) === 'gear') {
      const archived = isArchived(it);
      const ref = [it.brand, it.model].filter(Boolean).join(' ');
      const w = it.warranty_until ? warrantyState(it.warranty_until) : null;
      return h('div', { class: 'preview-body' },
        kicker(it.type ? capitalize(it.type) : 'Gear', archived ? '■ archived' : '● in use', archived && 'archived'),
        h('h2', { class: 'preview-title' }, it.name),
        ref ? h('p', { class: 'ds-sub' }, ref) : null,
        section('Specification', null, h('dl', { class: 'spec' },
          pair('Type', it.type ? link(it.type, `type:${it.type.split(' ')[0]}`, 'tag') : none()),
          pair('Brand', it.brand || none()),
          pair('Reference', it.model ? h('span', { class: 'copyable mono' }, it.model) : none()),
          pair('Serial no.', it.serial ? h('span', { class: 'copyable mono serial' }, it.serial) : none(),
            it.serial ? h('button', { type: 'button', class: 'button small', onclick: () => this.copy(it.serial, 'Serial number copied') }, 'Copy') : null),
          pair('Warranty', w ? [h('span', { class: 'mono' }, it.warranty_until), h('span', { class: ['warranty', w.state] }, w.text)] : none()),
          it.price ? pair('Purchase price', h('span', { class: 'mono' }, formatPrice(it.price))) : null,
          common)),
        filesSection(this, it),
        // Phones: Edit is in the header and Attach above, so only the rest.
        isMobile()
          ? h('div', { class: 'page-actions' },
            h('button', { type: 'button', class: 'button wide', onclick: () => this.toggleArchive(it) }, archived ? 'Restore to the gear in use' : 'Archive this item'),
            h('button', { type: 'button', class: 'button wide danger-text', onclick: () => this.remove([it]) }, 'Delete item'))
          : h('div', { class: 'preview-actions' },
            action('e', 'edit', () => this.edit(it)),
            action('f', 'attach', () => this.pickFiles(it)),
            action('A', archived ? 'restore' : 'archive', () => this.toggleArchive(it)),
            action('d', 'delete', () => this.remove([it]), 'danger-text')),
        h('p', { class: 'ds-note' }, archived
          ? 'Archived: out of the gear list, kept with its serial number and files.'
          : 'Broken, lost or sold? Archive it: it leaves the list and keeps its serial number and files.'));
    }

    return h('div', { class: 'preview-body' },
      kicker('Part', it.to_buy ? '▲ to buy' : it.quantity ? '● in stock' : '○ none left', it.to_buy && 'to-buy'),
      h('h2', { class: 'preview-title' }, it.name),
      h('p', { class: 'ds-sub' }, [it.slots.join(', ') || 'no slot', it.aliases.join(', ')].filter(Boolean).join(' · ')),
      section('Stock', isMobile() ? 'tap the number to type it' : 'x to type it',
        this.quantityControl(it),
        h('p', { class: ['qty-note', it.to_buy && 'to-buy'] }, it.to_buy
          ? 'On the shopping list: it leaves as soon as the count is above 0.'
          : 'At 0 the part goes to the shopping list.'),
        it.to_buy ? h('div', { class: 'preview-actions shopping-actions' },
          action('x', 'bought: set qty', () => this.setQuantity(it), 'primary'),
          action('d', 'won’t buy: delete', () => this.remove([it]), 'danger-text')) : null),
      section('Specification', null, h('dl', { class: 'spec' },
        pair('Slot', it.slots.length ? it.slots.map((sl) => link(sl, sl, 'slot')) : none(),
          h('button', { type: 'button', class: 'button small', onclick: () => this.moveTargets([it]) }, 'Move')),
        it.price
          ? pair('Unit price', [h('span', { class: 'mono' }, formatPrice(it.price)),
            it.quantity > 1 ? h('span', { class: 'muted mono' }, ` · ${formatPrice(it.price * it.quantity)} for ${it.quantity}`) : null])
          : null,
        common)),
      filesSection(this, it),
      // Phones: Edit is in the header, Move by the slot (tap a used slot to swap).
      isMobile()
        ? h('div', { class: 'page-actions' },
          h('button', { type: 'button', class: 'button wide danger-text', onclick: () => this.remove([it]) }, 'Delete part'))
        : h('div', { class: 'preview-actions' },
          action('e', 'edit', () => this.edit(it)),
          action('m', 'move', () => this.moveTargets([it])),
          action('s', 'swap', () => this.swap(it.slots[0])),
          action('t', 'tags', () => this.tagTargets([it])),
          action('d', 'delete', () => this.remove([it]), 'danger-text')),
      it.slots[0] ? this.neighbours(it.slots[0], it) : null);
  }

  /** [−] 12 [+]: the number itself turns into a field to type it. */
  quantityControl(it) {
    return h('div', { class: ['quantity-control', quantityClass(it)] },
      h('button', { type: 'button', class: 'qty-step', title: 'One less (-)', attrs: { 'aria-label': 'One less' }, disabled: it.quantity === 0, onclick: () => this.changeQuantity(it, -1) }, '−'),
      this.editingQty === it.id
        ? this.quantityInput(it)
        : h('button', { type: 'button', class: 'qty-value', title: 'Type the quantity (x)', onclick: () => this.setQuantity(it) }, String(it.quantity)),
      h('button', { type: 'button', class: 'qty-step', title: 'One more (+)', attrs: { 'aria-label': 'One more' }, onclick: () => this.changeQuantity(it, 1) }, '+'));
  }

  /** The quantity typed in place: Enter or leaving the field saves, Escape cancels. */
  quantityInput(it) {
    const input = h('input', {
      type: 'number', class: 'qty-edit', min: 0, max: 1000000, step: 1, inputMode: 'numeric', value: it.quantity,
      attrs: { 'aria-label': `Quantity of ${it.name}`, enterkeyhint: 'done' },
    });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this.editingQty = null;
      const value = Number(input.value);
      if (save && input.value.trim() !== '' && Number.isInteger(value) && value >= 0 && value !== it.quantity) {
        this.saveQuantity(it, value);
      } else {
        this.renderPreview();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    return input;
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
    return h('section', { class: 'ds-section' },
      h('h3', { class: 'ds-head' }, h('span', null, 'Neighbours')),
      others.map((it) => line(slot, it.name, () => this.focusItem(it))),
      around.map((n) => line(n, slotSummary(this, n), open(n))));
  }

  /**
   * Phones show the details full screen. The sheet follows its item (not the
   * cursor) and is redrawn after every change, so − / + update it in place.
   */
  openPreviewSheet() {
    const row = this.cursorRow();
    if (!row) return;
    const body = h('div', { class: 'sheet-content' });
    const back = { parts: '← Parts', gear: this.archived ? '← Archive' : '← Gear', shopping: '← To buy' }[this.view];
    const modal = openModal({
      title: '',
      back,
      action: row.kind === 'item' ? { label: 'Edit', run: () => this.edit(this.sheet?.row.item) } : null,
      className: 'preview-sheet',
      body,
      autofocus: false,
      onClose: () => { if (this.sheet?.modal === modal) this.sheet = null; },
    });
    this.sheet = { modal, body, row };
    this.renderSheet();
  }

  renderSheet() {
    if (!this.sheet) return;
    let { row } = this.sheet;
    if (row.kind === 'item') {
      const item = this.byId.get(row.item.id);
      if (!item) return this.sheet.modal.close(); // deleted
      row = { ...row, item };
      this.sheet.row = row;
    }
    this.sheet.body.replaceChildren(this.previewContent(row));
  }

  renderStatus(mode) {
    const insert = mode ? mode === 'INSERT' : document.activeElement === this.search;
    const el = $('status-mode');
    el.textContent = insert ? '-- SEARCH --' : '-- NORMAL --';
    el.className = `status-mode ${insert ? 'insert' : 'normal'}`;
    const total = this.rows.length;
    $('status-position').textContent = `${total ? this.cursor + 1 : 0} / ${total}`;

    let parts = 0;
    let toBuy = 0;
    let gear = 0;
    let archived = 0;
    for (const it of this.items) {
      if (itemKind(it) === 'gear') {
        if (isArchived(it)) archived++;
        else gear++;
      } else {
        parts++;
        if (it.to_buy) toBuy++;
      }
    }
    const title = { parts: 'Parts', gear: this.archived ? 'Archive' : 'Gear', shopping: 'To buy' }[this.view];
    $('view-title').textContent = title;
    $('meta-title').textContent = `Inventory · ${title}`;
    $('meta-info').textContent = {
      parts: `${parts} part${parts === 1 ? '' : 's'} · ${this.boxes.length} box${this.boxes.length === 1 ? '' : 'es'}`,
      gear: `${gear} in use · ${archived} archived`,
      shopping: `${toBuy} to buy`,
    }[this.view];
    const pool = { parts, gear: this.archived ? archived : gear, shopping: toBuy }[this.view];
    $('result-count').textContent = `${total}/${pool}`;
    $('search-clear').hidden = !this.query;
    for (const v of VIEWS) $(`tab-${v}`).classList.toggle('active', this.view === v);
    $('shopping-count').textContent = toBuy ? String(toBuy) : '';
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
  /** Shows one item, in its tab; with open, also its details (full screen on phones). */
  focusItem(item, { open = false } = {}) {
    closeAllModals();
    const view = itemKind(item) === 'gear' ? 'gear' : 'parts';
    if (view === 'gear' && (this.view !== 'gear' || this.archived !== isArchived(item))) this.setArchived(isArchived(item));
    else if (this.view !== view && !(this.view === 'shopping' && item.to_buy)) this.setView(view);
    let i = this.rows.findIndex((r) => r.item?.id === item.id);
    if (i < 0) {
      this.setQuery('');
      i = this.rows.findIndex((r) => r.item?.id === item.id);
    }
    this.cursor = Math.max(0, i);
    this.render();
    if (open && isMobile()) this.openPreviewSheet();
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

  /** The item form, for a new item: in a slot, or with a name, when given. */
  add({ slot = '', name = '' } = {}) {
    const row = this.cursorRow();
    if (!slot && !name && row?.kind === 'empty') slot = row.slot;
    if (!slot && !name && this.slotBanner && !this.slotBanner.count) slot = this.slotBanner.slot;
    openItemForm(this, { kind: this.view === 'gear' ? 'gear' : 'part', slot, name });
  }

  edit(item = this.cursorItem()) {
    if (item) openItemForm(this, { item });
  }

  async moveTargets(items = this.targets()) {
    if (!items.length) return;
    // Slots are picked on the map of a box.
    if (items.length === 1) return openSlotMap(this, { item: items[0] });
    const slot = await openSlotMap(this, { items });
    if (slot) await this.moveTo(items, slot);
  }

  async moveTo(items, slot) {
    const undo = this.snapshot(items);
    const data = await this.run(() => api.items.move(items.map((it) => it.id), slot));
    if (!data) return;
    this.selected.clear();
    this.setInventory(data);
    this.done(items.length === 1 ? `Moved “${items[0].name}” to ${slot}` : `Moved ${items.length} items to ${slot}`, undo);
  }

  /** Moves one of the slots of an item, keeping the others. */
  async replaceSlot(item, from, to) {
    const undo = this.snapshot([item]);
    const updated = await this.run(() => api.items.update(item.id, { ...item, slots: item.slots.map((s) => (s === from ? to : s)) }));
    if (!updated) return;
    this.putItem(updated);
    this.done(`Moved “${item.name}” to ${to} (was ${from})`, undo);
  }

  async swap(from = this.cursorItem()?.slots[0] || (this.cursorRow()?.kind === 'empty' ? this.cursorRow().slot : '')) {
    const item = this.sheet?.row.item || this.cursorItem();
    if (item?.slots[0] === from) return openSlotMap(this, { item });
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

  /** Types the quantity in place when the details show the item, else in a dialog. */
  async setQuantity(item = this.cursorItem()) {
    if (!item) return;
    const shown = this.sheet ? this.sheet.row.item?.id : !isMobile() && this.cursorItem()?.id;
    if (shown === item.id) {
      this.editingQty = item.id;
      this.renderPreview();
      // Synchronously, within the tap: iOS only opens the keyboard then.
      const input = (this.sheet ? this.sheet.body : $('preview')).querySelector('.qty-edit');
      input?.focus();
      input?.select();
      return;
    }
    const value = await openQuantityDialog(item);
    if (value !== null && value !== item.quantity) await this.saveQuantity(item, value);
  }

  async saveQuantity(item, value) {
    const undo = this.snapshot([item]);
    const updated = await this.run(() => api.items.quantity(item.id, { set: value }));
    if (!updated) return this.renderPreview();
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

  /** Opens the file picker for an item (on iPhone: camera, photos or files). */
  pickFiles(item = this.cursorItem()) {
    if (!item) return;
    const input = h('input', { type: 'file', multiple: true });
    input.addEventListener('change', () => this.attachFiles(item, [...input.files]));
    input.click();
  }

  async attachFiles(item, files) {
    if (!item || !files.length) return;
    const updated = await uploadFiles(this, item, files);
    if (!updated) return;
    this.putItem(updated);
    const added = updated.attachments.filter((a) => !item.attachments.some((b) => b.id === a.id));
    this.done(`${item.name}: ${added.length} file${added.length === 1 ? '' : 's'} attached`,
      () => Promise.all(added.map((a) => api.attachments.remove(a.id))));
  }

  openFirstFile(item = this.cursorItem()) {
    const file = item?.attachments?.[0];
    if (file) window.open(file.url, '_blank', 'noopener');
    else if (item) toast(`${item.name} has no file. press f to attach one.`);
  }

  /** Files dropped on the details pane go to the item it shows. */
  initDrop() {
    const pane = $('preview');
    let depth = 0;
    const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    pane.addEventListener('dragenter', (e) => {
      if (!has(e) || !this.cursorItem()) return;
      depth++;
      pane.classList.add('dropping');
    });
    pane.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        pane.classList.remove('dropping');
      }
    });
    pane.addEventListener('dragover', (e) => {
      if (has(e) && this.cursorItem()) e.preventDefault();
    });
    pane.addEventListener('drop', (e) => {
      depth = 0;
      pane.classList.remove('dropping');
      if (!has(e)) return;
      e.preventDefault();
      this.attachFiles(this.cursorItem(), [...e.dataTransfer.files]);
    });
  }

  /** Archives gear (broken, lost, sold: off the list, kept on record), or restores it. */
  async toggleArchive(item = this.cursorItem()) {
    if (!item) return;
    if (itemKind(item) !== 'gear') return toast('Only gear is archived: a part is in stock or on the shopping list.');
    const archive = !isArchived(item);
    const undo = this.snapshot([item]);
    const updated = await this.run(() => api.items.update(item.id, { ...item, status: archive ? 'archived' : '' }));
    if (!updated) return;
    this.putItem(updated);
    this.done(archive ? `Archived “${updated.name}”` : `Restored “${updated.name}” to the gear in use`, undo);
  }

  copy(text, message) {
    navigator.clipboard?.writeText(text).then(() => toast(message), () => toast(text));
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

  openGrid(boxId, options) {
    const row = this.cursorRow();
    const slot = row?.kind === 'empty' ? row.slot : row?.item?.slots[0] || this.slotBanner?.slot;
    return openGrid(this, boxId || (slot && parseSlot(slot).box), slot, options);
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

function itemKind(item) {
  return item.kind || 'part';
}

/** Types in alphabetical order; gear without a type comes last. */
function compareTypes(a, b) {
  const x = a.type || '';
  const y = b.type || '';
  if (!x !== !y) return x ? -1 : 1;
  return x.localeCompare(y);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isArchived(item) {
  return item.status === 'archived';
}

/** Valid until the end date (inclusive), with the months left; "ending" under 3. */
function warrantyState(end, today = new Date().toISOString().slice(0, 10)) {
  if (end < today) return { state: 'expired', text: 'expired' };
  const [y, m, d] = end.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const months = (y - ty) * 12 + (m - tm) - (d < td ? 1 : 0);
  return {
    state: months < 3 ? 'ending' : 'valid',
    text: months < 1 ? 'valid · ends this month' : `valid · ${months} mo. left`,
  };
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
