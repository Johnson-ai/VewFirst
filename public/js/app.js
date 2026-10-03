import { h, clear, state, get, post, icon, avatar, toast, refreshCounters, emptyState } from './lib.js';

// Each route: [regex, loader returning a view module function(container, params, query)]
const routes = [
  [/^\/$/, () => import('./views/home.js')],
  [/^\/search$/, () => import('./views/search.js')],
  [/^\/listing\/new$/, () => import('./views/editor.js')],
  [/^\/listing\/(\d+)\/edit$/, () => import('./views/editor.js')],
  [/^\/listing\/(\d+)$/, () => import('./views/listing.js')],
  [/^\/landlord\/(\d+)$/, () => import('./views/misc.js').then((m) => ({ default: m.landlordProfile }))],
  [/^\/login$/, () => import('./views/misc.js').then((m) => ({ default: m.login }))],
  [/^\/register$/, () => import('./views/misc.js').then((m) => ({ default: m.register }))],
  [/^\/favorites$/, () => import('./views/misc.js').then((m) => ({ default: m.favorites }))],
  [/^\/profile$/, () => import('./views/misc.js').then((m) => ({ default: m.profile }))],
  [/^\/notifications$/, () => import('./views/misc.js').then((m) => ({ default: m.notifications }))],
  [/^\/dashboard$/, () => import('./views/dashboard.js')],
  [/^\/viewings$/, () => import('./views/viewings.js')],
  [/^\/messages(?:\/(\d+))?$/, () => import('./views/messages.js')],
  [/^\/admin$/, () => import('./views/admin.js')],
];

const main = document.getElementById('main');
let cleanup = null;
let navToken = 0;

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(qs) };
}
export const go = (path) => { location.hash = path; };

async function render() {
  const token = ++navToken;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const { path, query } = parseHash();
  closeMenus();
  for (const [re, loader] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    clear(main).append(h('div', { class: 'wrap page' }, h('div', { class: 'skeleton', style: { height: '2rem', width: '40%' } }), h('div', { class: 'skeleton', style: { height: '14rem', marginTop: '1rem' } })));
    try {
      const mod = await loader();
      if (token !== navToken) return;
      clear(main);
      const out = await mod.default(main, m.slice(1), query);
      if (token === navToken && typeof out === 'function') cleanup = out;
    } catch (e) {
      if (token !== navToken) return;
      console.error(e);
      clear(main).append(h('div', { class: 'wrap page' }, emptyState('This page could not load', e.message || 'Please refresh and try again.', h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to home'))));
    }
    window.scrollTo({ top: 0 });
    main.focus({ preventScroll: true });
    document.title = (state.meta?.appName || 'ViewFirst') + (path === '/' ? ': tour it, then visit it' : '');
    renderHeader();
    return;
  }
  clear(main).append(h('div', { class: 'wrap page' }, emptyState('Page not found', 'The link may be old or mistyped.', h('a', { class: 'btn btn-primary', href: '#/' }, 'Back to home'))));
}

// ------------------------------------------------------------------ header / footer
function closeMenus() {
  document.querySelector('.nav')?.classList.remove('open');
  document.querySelector('.user-menu-panel')?.setAttribute('hidden', '');
}

export function renderHeader() {
  const host = document.getElementById('app-header');
  const { path } = parseHash();
  const u = state.user;
  const c = state.counters;
  const link = (href, label, extra) => {
    const active = path === href.slice(1) || (href !== '#/' && path.startsWith(href.slice(1) + '/'));
    return h('a', { href, class: active ? 'active' : '' }, label, extra);
  };
  const pip = (n) => (n > 0 ? h('span', { class: 'pip', 'aria-label': `${n} new` }, n > 9 ? '9+' : n) : null);
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    link('#/search', 'Find a place'),
    u ? link('#/favorites', 'Saved') : null,
    u ? link('#/messages', 'Messages', pip(c.messages)) : null,
    u ? link('#/viewings', 'Viewings', pip(c.viewings)) : null,
    u && (u.role === 'landlord') ? link('#/dashboard', 'My listings') : null,
    u && u.role === 'admin' ? link('#/admin', 'Admin') : null,
    !u ? h('a', { href: '#/register?role=landlord' }, 'List a property') : null);

  const menuPanel = h('div', { class: 'user-menu-panel', hidden: true },
    u ? [h('div', { class: 'who' }, h('strong', null, u.name), h('div', { class: 'small muted' }, u.email), u.role === 'landlord' && u.verified ? h('div', { class: 'small' }, '✔ Verified landlord') : null),
      h('a', { href: '#/profile' }, 'Profile and settings'),
      h('a', { href: '#/notifications' }, 'Notifications' + (c.notifications ? ` (${c.notifications})` : '')),
      h('button', { onclick: logout }, 'Log out')] : null);

  const userBtn = u ? h('div', { class: 'user-menu' },
    h('button', { class: 'icon-btn', 'aria-label': 'Account menu', 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); menuPanel.toggleAttribute('hidden'); } }, avatar(u, 34), pip(c.notifications)),
    menuPanel) : null;

  const header = h('header', { class: 'site-header' }, h('div', { class: 'wrap' },
    h('a', { class: 'logo', href: '#/', 'aria-label': `${state.meta?.appName || 'ViewFirst'} home` },
      h('span', { class: 'logo-mark' }, (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 32 32'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M6 25V13l10-8 10 8v12h-6.500v-7h-7v7z'); s.appendChild(p); return s; })()),
      state.meta?.appName || 'ViewFirst'),
    nav,
    h('div', { class: 'header-actions' },
      u ? userBtn : [h('a', { class: 'btn btn-ghost', href: '#/login' }, 'Log in'), h('a', { class: 'btn btn-primary', href: '#/register' }, 'Sign up')],
      h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Menu', onclick: () => nav.classList.toggle('open') }, icon('list', 22)))));
  clear(host).append(header);
}

function renderFooter() {
  clear(document.getElementById('app-footer')).append(h('footer', { class: 'site-footer' }, h('div', { class: 'wrap' },
    h('div', null, h('strong', null, state.meta.appName), ' connects tenants directly with landlords. No agent fees on this platform.'),
    h('div', { class: 'muted' }, 'Safety: never send money before you have toured the place and met the landlord. Report anything suspicious from the listing page.'))));
}

async function logout() {
  await post('/api/auth/logout');
  state.user = null; state.counters = { messages: 0, notifications: 0, viewings: 0 };
  toast('You are logged out');
  go('/');
  renderHeader();
}

// ------------------------------------------------------------------ boot
document.addEventListener('click', () => document.querySelector('.user-menu-panel')?.setAttribute('hidden', ''));
window.addEventListener('hashchange', render);

/** Called by login/register views after the session changes. */
export async function refreshSession() {
  const me = await get('/api/me');
  state.user = me.user;
  await refreshCounters();
  renderHeader();
}

(async function boot() {
  try {
    [state.meta, { user: state.user }] = await Promise.all([get('/api/meta'), get('/api/me')]);
  } catch (e) {
    main.append(h('div', { class: 'wrap page' }, emptyState('Cannot reach the server', 'Check your connection and refresh the page.')));
    return;
  }
  await refreshCounters();
  renderHeader(); renderFooter();
  await render();
  setInterval(async () => { if (!document.hidden && state.user) { await refreshCounters(); renderHeader(); } }, 25000);
})();
