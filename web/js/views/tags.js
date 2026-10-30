// Tag manager: every tag as a tree with its item count. Renaming a tag also
// renames its sub-tags, and renaming onto an existing tag merges the two.

import { h, clear } from '../dom.js';
import { openModal, promptDialog, confirmDialog, toast } from '../ui/overlay.js';
import { api } from '../api.js';

export function openTags(app) {
  const list = h('div', { class: 'tag-list' });

  function render() {
    clear(list);
    const tags = [...app.tagCounts.keys()].sort();
    if (!tags.length) {
      list.append(h('p', { class: 'dialog-message' }, 'No tags yet. Add some with #tag in Quick Add.'));
      return;
    }
    for (const tag of tags) {
      const depth = tag.split('/').length - 1;
      const leaf = tag.split('/').pop();
      list.append(h('div', { class: 'tag-row', style: { paddingLeft: `${8 + depth * 18}px` } },
        h('button', { type: 'button', class: 'tag-name', onclick: () => { modal.close(); app.setQuery(`#${tag}`); } }, `#${leaf}`),
        h('span', { class: 'tag-count' }, app.tagCounts.get(tag)),
        h('button', { type: 'button', class: 'button small', onclick: () => rename(tag) }, 'Rename'),
        h('button', { type: 'button', class: 'button small danger-text', onclick: () => remove(tag) }, 'Delete')));
    }
  }

  async function rename(tag) {
    const to = await promptDialog(`Rename #${tag}`, { value: tag, okText: 'Rename' });
    if (!to || to === tag) return;
    const undoItems = app.items.filter((it) => it.tags.some((t) => t === tag || t.startsWith(`${tag}/`)));
    const undo = app.snapshot(undoItems);
    const data = await app.run(() => api.renameTag(tag, to));
    if (!data) return;
    app.setInventory(data);
    app.done(`Renamed #${tag}`, undo);
    render();
  }

  async function remove(tag) {
    const holders = app.items.filter((it) => it.tags.includes(tag));
    if (!holders.length) return toast(`#${tag} only groups sub-tags: delete or rename those`);
    const ok = await confirmDialog(`Delete #${tag}?`, `It is removed from ${holders.length} item${holders.length === 1 ? '' : 's'}. Sub-tags stay.`, { okText: 'Delete' });
    if (!ok) return;
    const undo = app.snapshot(holders);
    const data = await app.run(() => api.deleteTag(tag));
    if (!data) return;
    app.setInventory(data);
    app.done(`Deleted #${tag}`, undo);
    render();
  }

  const modal = openModal({ title: 'Tags', className: 'tags-modal', body: list, autofocus: false });
  render();
}
