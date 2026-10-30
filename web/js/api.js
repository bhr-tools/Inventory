// HTTP client for the Inventory API. Every call returns the decoded JSON or
// throws an ApiError whose message can be shown to the user.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let unauthorizedHandler = () => {};

/** Called whenever the server says the session is no longer valid. */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

async function request(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }

  let data = null;
  if ((res.headers.get('Content-Type') || '').includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedHandler();
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

const get = (path) => request('GET', path);
const post = (path, body = {}) => request('POST', path, body);
const put = (path, body) => request('PUT', path, body);
const del = (path) => request('DELETE', path);
const id = encodeURIComponent;

// Calls answering { items, boxes } hand back the whole inventory.
export const api = {
  auth: {
    status: () => get('/api/auth/status'),
    setup: (password) => post('/api/auth/setup', { password }),
    login: (password) => post('/api/auth/login', { password }),
    logout: () => post('/api/auth/logout'),
    changePassword: (oldPassword, newPassword) =>
      post('/api/auth/change-password', { old_password: oldPassword, new_password: newPassword }),
  },

  inventory: () => get('/api/inventory'),

  items: {
    create: (item) => post('/api/items', item),
    update: (itemId, item) => put(`/api/items/${id(itemId)}`, item),
    /** Answers { items } with the removed items, for restore(). */
    remove: (ids) => post('/api/items/delete', { ids }),
    /** Puts items back as they were (also undoes edits). */
    restore: (items) => post('/api/items/restore', { items }),
    /** change: { delta } or { set } */
    quantity: (itemId, change) => post(`/api/items/${id(itemId)}/quantity`, change),
    move: (ids, slot) => post('/api/items/move', { ids, slot }),
    tag: (ids, add, remove) => post('/api/items/tag', { ids, add, remove }),
  },

  swapSlots: (a, b) => post('/api/slots/swap', { a, b }),
  renameTag: (from, to) => post('/api/tags/rename', { from, to }),
  deleteTag: (tag) => post('/api/tags/delete', { tag }),
  setBox: (boxId, slots, columns) => put(`/api/boxes/${id(boxId)}`, { slots, columns }),
  deleteBox: (boxId) => del(`/api/boxes/${id(boxId)}`),

  async exportCSV() {
    const res = await fetch('/api/export', { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError('Export failed', res.status);
    const plain = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    return { blob: await res.blob(), filename: plain ? plain[1] : 'inventory.csv' };
  },
  importCSV(file) {
    const form = new FormData();
    form.append('file', file);
    return request('POST', '/api/import', form);
  },
};
