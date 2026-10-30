// Vim-style keyboard control. One window-level handler decides, in order:
//   1. Escape closes the topmost popover or dialog;
//   2. while a dialog is open, other keys belong to it;
//   3. while typing in a field (the search or any other), keys belong to it;
//   4. otherwise keys are commands for the result list.
// Components that handle a key themselves call preventDefault(), and this
// handler then ignores it.

import { escapeTopLayer, topModal, isPopoverOpen } from './ui/overlay.js';
import { isTextInput } from './dom.js';
import { openHelp } from './views/help.js';
import { openTags } from './views/tags.js';

export function initKeys(app) {
  let pendingG = 0;

  const updateMode = () => app.renderStatus();
  document.addEventListener('focusin', updateMode);
  document.addEventListener('focusout', () => setTimeout(updateMode, 0));

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;

    if (e.key === 'Escape') {
      if (escapeTopLayer()) {
        e.preventDefault();
        return;
      }
      if (isTextInput(document.activeElement)) {
        e.preventDefault();
        document.activeElement.blur();
        return;
      }
    }
    if (topModal() || isPopoverOpen() || isTextInput(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (listKey(e.key)) e.preventDefault();
  });

  function listKey(key) {
    if (key === 'g') {
      if (Date.now() - pendingG < 1000) {
        pendingG = 0;
        app.moveCursorTo(0);
      } else {
        pendingG = Date.now();
      }
      return true;
    }
    pendingG = 0;
    switch (key) {
      case 'j': case 'ArrowDown': app.moveCursor(1); return true;
      case 'k': case 'ArrowUp': app.moveCursor(-1); return true;
      case 'G': app.moveCursorTo(-1); return true;
      case 'e': case 'Enter': {
        const row = app.cursorRow();
        if (row?.kind === 'empty') app.quickAdd(`${row.slot} `);
        else app.edit();
        return true;
      }
      case 'a': case 'q': app.quickAdd(); return true;
      case '+': case '=': app.changeQuantity(app.cursorItem(), 1); return true;
      case '-': app.changeQuantity(app.cursorItem(), -1); return true;
      case 'x': app.setQuantity(); return true;
      // 1 and 2, or & and é on AZERTY: the two tabs.
      case '1': case '&': app.setView('inventory'); return true;
      case '2': case 'é': app.setView('shopping'); return true;
      case ' ': app.toggleSelection(); return true;
      case 'm': app.moveTargets(); return true;
      case 's': app.swap(); return true;
      case 't': app.tagTargets(); return true;
      case 'T': openTags(app); return true;
      case 'd': app.remove(); return true;
      case 'u': app.undo(); return true;
      case 'b': app.openGrid(); return true;
      case '/': case 'i': app.focusSearch(); return true;
      case '?': openHelp(); return true;
      case 'Escape': app.escape(); return true;
    }
    return false;
  }
}
