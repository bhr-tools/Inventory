// Files attached to an item: invoices, manuals, photos, datasheets. Listed in
// the details, opened through their signed link (which also works in the
// viewer iOS opens from a home screen app), renamed, relabelled or deleted.

import { h, isMobile } from '../dom.js';
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
  const rows = files.map((f, i) => h('div', { class: 'file-row' },
    h('span', { class: 'file-index' }, String(i + 1).padStart(2, '0')),
    h('span', { class: 'file-main' },
      h('button', {
        type: 'button',
        class: ['file-label', f.label || 'other'],
        title: 'Change the label',
        onclick: (e) => openMenu(e.currentTarget, LABELS.map((l) => ({
          label: l || 'other',
          selected: l === f.label,
          run: () => change(() => api.attachments.relabel(f.id, l), `${f.filename}: ${l || 'other'}`,
            () => api.attachments.relabel(f.id, f.label)),
        })), { title: 'Label' }),
      }, f.label || 'other'),
      h('a', { class: 'file-name', href: f.url, target: '_blank', rel: 'noopener', title: f.filename }, f.filename)),
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
    }, 'rename'),
    h('button', {
      type: 'button',
      class: 'file-action danger',
      title: 'Delete',
      attrs: { 'aria-label': `Delete ${f.filename}` },
      onclick: () => change(() => api.attachments.remove(f.id), `deleted ${f.filename}`, () => api.attachments.restore(f.id)),
    }, '×')));
  const empty = item.kind === 'gear'
    ? 'No invoice yet. Attach it now, so you have it the day it breaks.'
    : 'No datasheet or pinout attached.';
  return h('section', { class: 'ds-section files' },
    h('h3', { class: 'ds-head' }, h('span', null, 'Documents'), h('span', { class: 'aside' }, files.length ? String(files.length) : '')),
    rows,
    files.length ? null : h('p', { class: 'ds-note' }, empty),
    h('button', { type: 'button', class: 'drop-zone', onclick: () => app.pickFiles(item) },
      isMobile() ? 'Attach a document' : 'Attach a document, or drop files here'));
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
