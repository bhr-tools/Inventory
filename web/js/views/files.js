// Files attached to an item: invoices, manuals, photos, datasheets. Listed in
// the details, opened through their signed link (which also works in the
// viewer iOS opens from a home screen app), renamed, relabelled or deleted.

import { h } from '../dom.js';
import { promptDialog, openMenu, toast } from '../ui/overlay.js';
import { api } from '../api.js';

const LABELS = ['invoice', 'manual', 'photo', 'datasheet', ''];

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The "files" block of an item's details. */
export function filesSection(app, item) {
  const files = item.attachments || [];
  const change = async (call, message, undo) => {
    const updated = await app.run(call);
    if (!updated) return;
    app.putItem(updated);
    app.done(message, undo);
  };
  const rows = files.map((f) => h('div', { class: 'file-row' },
    h('button', {
      type: 'button',
      class: ['file-label', f.label || 'other'],
      title: 'Change the label',
      onclick: (e) => openMenu(e.currentTarget, LABELS.map((l) => ({
        label: l || 'other',
        selected: l === f.label,
        run: () => change(() => api.attachments.relabel(f.id, l), `${f.filename}: ${l || 'other'}`,
          () => api.attachments.relabel(f.id, f.label)),
      }))),
    }, f.label || 'other'),
    h('a', { class: 'file-name', href: f.url, target: '_blank', rel: 'noopener', title: f.filename }, f.filename),
    h('span', { class: 'file-meta' }, formatSize(f.size)),
    h('button', {
      type: 'button',
      class: 'file-action',
      title: 'Rename',
      onclick: async () => {
        const name = await promptDialog('Rename the file', { value: f.filename, okText: 'Rename' });
        if (name && name !== f.filename) {
          change(() => api.attachments.rename(f.id, name), `renamed to ${name}`, () => api.attachments.rename(f.id, f.filename));
        }
      },
    }, 'ren'),
    h('button', {
      type: 'button',
      class: 'file-action danger',
      title: 'Delete',
      onclick: () => change(() => api.attachments.remove(f.id), `deleted ${f.filename}`, () => api.attachments.restore(f.id)),
    }, 'del')));
  return h('section', { class: 'preview-section files' },
    h('h3', null, `files (${files.length})`),
    rows,
    h('button', { type: 'button', class: 'drop-zone', onclick: () => app.pickFiles(item) },
      files.length ? '+ attach, or drop files here' : 'no file yet. attach an invoice or a manual, or drop files here'));
}

/**
 * Uploads files to an item, showing the progress in a toast. Resolves to the
 * updated item, or null on failure (the error is shown).
 */
export async function uploadFiles(app, item, files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  toast(`uploading ${label} (${formatSize(total)})…`);
  let last = 0;
  try {
    return await api.upload(item.id, files, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (pct - last >= 5 || pct === 100) {
        last = pct;
        toast(`uploading ${label}: ${pct}%`);
      }
    });
  } catch (err) {
    app.report(err);
    return null;
  }
}
