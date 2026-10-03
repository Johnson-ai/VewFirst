// Shared helpers. Everything user-supplied is rendered with textContent (via h()) so XSS payloads stay inert.

export const state = { user: null, meta: null, counters: { messages: 0, notifications: 0, viewings: 0 } };

/** Tiny hyperscript: h('div', {class:'x', onclick}, 'text', [children]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}
// Make Element.append behave like h(): skip null/undefined/false and flatten arrays (native append prints "null").
Element.prototype.append = function (...children) { append(this, children); };

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------ API
export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }

export async function api(method, url, body, opts = {}) {
  const headers = { 'X-Requested-With': 'viewfirst' };
  let payload;
  if (body instanceof Blob) { payload = body; headers['Content-Type'] = body.type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError('Network problem. Check your connection and try again.', 0); }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError((data && data.error) || 'Something went wrong.', res.status, data);
  return data;
}
export const get = (u, o) => api('GET', u, undefined, o);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b = {}) => api('PUT', u, b);
export const del = (u) => api('DELETE', u);

/** Upload a File/Blob as raw body; returns {path,width,height,size}. */
export function upload(kind, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?kind=${kind}`);
    xhr.setRequestHeader('X-Requested-With', 'viewfirst');
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new ApiError(data.error || 'Upload failed.', xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection.', 0));
    xhr.send(blob);
  });
}

/** Shrink big photos in the browser before upload (keeps tours fast on slow connections). */
export async function shrinkImage(file, maxW, quality = 0.86) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width <= maxW && file.size < 3 * 1024 * 1024) { bmp.close?.(); return file; }
    const scale = Math.min(1, maxW / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob || file;
  } catch { return file; }
}

export function imageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

// ------------------------------------------------------------------ formatting
export function money(n) {
  const { currency = 'NGN', locale = 'en-NG' } = state.meta || {};
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n); }
  catch { return `${currency} ${Number(n).toLocaleString()}`; }
}
export const priceLabel = (l) => `${money(l.price)} / ${l.period === 'month' ? 'month' : 'year'}`;
const asUtc = (s) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
export const dateTime = (s) => asUtc(s).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const dateOnly = (s) => asUtc(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export function timeAgo(s) {
  const sec = Math.max(1, Math.floor((Date.now() - asUtc(s).getTime()) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} d ago`;
  return dateOnly(s);
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
export const initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || '').join('');
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------------------ icons (static, trusted SVG strings)
const PATHS = {
  heart: 'M12 21s-7-4.6-9.3-9.1C1 8.5 2.8 5 6.2 5c2 0 3.2 1 3.8 2 .6-1 1.800-2 3.800-2 3.400 0 5.200 3.500 3.500 6.900C19 16.400 12 21 12 21z',
  pin: 'M12 22s7-6.200 7-12a7 7 0 10-14 0c0 5.800 7 12 7 12zm0-9a3 3 0 110-6 3 3 0 010 6z',
  bed: 'M3 18V7m0 7h18v4M21 14V10a2 2 0 00-2-2h-7v6M7 11.500a1.500 1.500 0 100-.01',
  bath: 'M4 12h16v3a4 4 0 01-4 4H8a4 4 0 01-4-4v-3zm2 0V6a2 2 0 014 0M7 19l-1 2m11-2l1 2',
  shield: 'M12 3l8 3v6c0 4.500-3.200 8-8 9-4.800-1-8-4.500-8-9V6l8-3zm-3.500 9l2.500 2.500L16 9.500',
  vr: 'M3 8h18a1 1 0 011 1v6a1 1 0 01-1 1h-5l-2-2.500h-4L8 16H3a1 1 0 01-1-1V9a1 1 0 011-1z',
  play: 'M8 5v14l11-7z',
  send: 'M21 3L3 11l7 2.500L13 21l8-18z',
  bell: 'M6 9a6 6 0 1112 0c0 6 2.500 7 2.500 7h-17S6 15 6 9zm4 10a2 2 0 004 0',
  chat: 'M4 5h16v11H9l-5 4V5z',
  calendar: 'M4 6h16v14H4V6zm0 5h16M8 3v5m8-5v5',
  close: 'M6 6l12 12M18 6L6 18',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  star: 'M12 3l2.700 5.800 6.300.7-4.700 4.300 1.300 6.200L12 17l-5.600 3 1.300-6.200L3 9.500l6.300-.7L12 3z',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  share: 'M12 15V3m0 0L8 7m4-4l4 4M5 12v8h14v-8',
  compass: 'M12 22a10 10 0 110-20 10 10 0 010 20zm3-13l-2 5-5 2 2-5 5-2z',
  check: 'M5 12.500l4.500 4.500L19 7.500',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0L8 8m4-4l4 4M4 16v4h16v-4',
  trash: 'M5 7h14M10 7V4h4v3m-7 0l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  home: 'M3 11l9-8 9 8v9h-6v-6H9v6H3v-9z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9c0-4 3.500-6 8-6s8 2 8 6',
  lock: 'M6 11h12v9H6v-9zm2 0V8a4 4 0 118 0v3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  map: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14',
  list: 'M8 6h13M8 12h13M8 18h13M3.500 6h.01M3.500 12h.01M3.500 18h.01',
  filter: 'M3 5h18l-7 8v6l-4-2v-4L3 5z',
  tag: 'M3 12V4h8l10 10-8 8L3 12zm4-5.500h.01',
};
export function icon(name, size = 18, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', name === 'play' || name === 'star' ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', `icon ${cls}`);
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', PATHS[name] || PATHS.check);
  svg.appendChild(p);
  return svg;
}

// ------------------------------------------------------------------ toasts + modal
let toastHost;
export function toast(message, kind = 'info') {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3800);
}
export const fail = (e) => { if (e?.name === 'AbortError') return; toast(e?.message || 'Something went wrong.', 'error'); };

export function modal(title, bodyBuilder, { wide = false } = {}) {
  const prev = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const body = h('div', { class: 'modal-body' });
  const dialog = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))), body);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  bodyBuilder(body, close);
  (body.querySelector('input,textarea,select,button') || dialog).focus?.();
  return close;
}

export const confirmDialog = (title, text, okLabel = 'Confirm', danger = false) => new Promise((resolve) => {
  let done = false;
  const close = modal(title, (body, closeFn) => {
    body.append(h('p', null, text), h('div', { class: 'row end gap' },
      h('button', { class: 'btn', onclick: () => { done = true; resolve(false); closeFn(); } }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { done = true; resolve(true); closeFn(); } }, okLabel)));
  });
  setTimeout(() => { /* resolve false if dismissed */ const obs = new MutationObserver(() => { if (!document.querySelector('.overlay') && !done) { done = true; resolve(false); obs.disconnect(); } }); obs.observe(document.body, { childList: true }); }, 0);
  return close;
});

// ------------------------------------------------------------------ misc
const loaded = {};
export function loadScript(src) {
  if (loaded[src]) return loaded[src];
  return (loaded[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = resolve; s.onerror = () => { delete loaded[src]; reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  }));
}
export function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.appendChild(h('link', { rel: 'stylesheet', href }));
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

export function stars(value, size = 16) {
  const wrap = h('span', { class: 'stars', 'aria-label': value ? `${value} out of 5` : 'No rating yet' });
  for (let i = 1; i <= 5; i++) wrap.append(h('span', { class: i <= Math.round(value || 0) ? 'on' : '' }, icon('star', size)));
  return wrap;
}

export function starInput(initial, onChange) {
  let value = initial || 0;
  const wrap = h('div', { class: 'star-input', role: 'radiogroup' });
  const draw = () => {
    clear(wrap);
    for (let i = 1; i <= 5; i++) {
      wrap.append(h('button', { type: 'button', class: i <= value ? 'on' : '', role: 'radio', 'aria-checked': i === value, 'aria-label': `${i} star${i > 1 ? 's' : ''}`, onclick: () => { value = value === i ? 0 : i; onChange(value); draw(); } }, icon('star', 22)));
    }
  };
  draw();
  return wrap;
}

export function avatar(user, size = 36) {
  const style = { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.38) + 'px' };
  if (user?.avatar) return h('img', { class: 'avatar', src: user.avatar, alt: '', style });
  return h('span', { class: 'avatar avatar-fallback', style, 'aria-hidden': 'true' }, initials(user?.name));
}

export function verifiedBadge(text = 'Verified landlord') {
  return h('span', { class: 'badge-verified', title: 'Identity and ownership documents checked by our team' }, icon('shield', 14), text);
}

export async function refreshCounters() {
  if (!state.user) { state.counters = { messages: 0, notifications: 0, viewings: 0 }; return; }
  try { state.counters = await get('/api/counters'); } catch { /* ignore */ }
}

export const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { toast('Copy this link: ' + text); }
};
