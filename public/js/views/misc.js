import {
  h, clear, state, get, post, put, icon, toast, fail, field, upload, shrinkImage, avatar, stars, verifiedBadge, dateOnly, timeAgo, plural, emptyState, refreshCounters,
} from '../lib.js';
import { listingCard, loadFavoriteIds } from '../cards.js';
import { refreshSession, parseHash } from '../app.js';

const afterAuth = () => { const next = sessionStorage.getItem('vf_next'); sessionStorage.removeItem('vf_next'); location.hash = next || (state.user.role === 'landlord' ? '/dashboard' : '/search'); };

export function login(root) {
  if (state.user) { location.hash = '/'; return; }
  const err = h('div', { class: 'form-error', hidden: true });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, 'Log in');
  root.append(h('div', { class: 'wrap' }, h('form', { class: 'auth-card', onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try { await post('/api/auth/login', { email: email.value, password: pw.value }); await refreshSession(); toast('Welcome back', 'success'); afterAuth(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  } }, h('h1', { style: { fontSize: '1.8rem' } }, 'Log in'), err, field('Email', email), field('Password', pw), btn,
  h('p', { class: 'small muted center', style: { marginTop: '1rem' } }, 'New here? ', h('a', { href: '#/register' }, 'Create an account')))));
}

export function register(root, _p, query) {
  if (state.user) { location.hash = '/'; return; }
  const err = h('div', { class: 'form-error', hidden: true });
  const startRole = query.get('role') === 'landlord' ? 'landlord' : 'tenant';
  const role = (value, title, sub) => h('label', null, h('input', { type: 'radio', name: 'role', value, checked: startRole === value }), h('b', null, title), h('span', null, sub));
  const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 80 });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true });
  const phone = h('input', { type: 'tel', autocomplete: 'tel', placeholder: '+234…' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const form = h('form', { class: 'auth-card', onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      await post('/api/auth/register', { name: name.value, email: email.value, phone: phone.value, password: pw.value, role: form.querySelector('input[name=role]:checked').value });
      await refreshSession(); toast('Account created', 'success'); afterAuth();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  } }, h('h1', { style: { fontSize: '1.8rem' } }, 'Create your account'), err,
  h('div', { class: 'role-pick' }, role('tenant', 'I am looking', 'Tour places and book viewings'), role('landlord', 'I own property', 'List and get verified')),
  field('Full name', name), field('Email', email), field('Phone (shared only after a viewing is confirmed)', phone), field('Password', pw, 'At least 8 characters.'),
  h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, 'Sign up'),
  h('p', { class: 'small muted center', style: { marginTop: '1rem' } }, 'Already registered? ', h('a', { href: '#/login' }, 'Log in')));
  root.append(h('div', { class: 'wrap' }, form));
}

export async function favorites(root) {
  if (!state.user) { sessionStorage.setItem('vf_next', '/favorites'); location.hash = '/login'; return; }
  const { items } = await get('/api/favorites');
  const favs = new Set(items.map((i) => i.id));
  root.append(h('div', { class: 'wrap page' }, h('h1', { style: { fontSize: '2rem' } }, 'Saved places'),
    items.length ? h('div', { class: 'cards' }, items.map((l) => listingCard(l, { favorites: favs, onFavChange: () => setTimeout(() => favorites(clear(root), []), 150) })))
      : emptyState('Nothing saved yet', 'Tap the heart on any listing to keep it here.', h('a', { class: 'btn btn-primary', href: '#/search' }, 'Browse places'))));
}

export async function landlordProfile(root, [id]) {
  let p;
  try { p = await get(`/api/landlords/${id}`); } catch (e) { root.append(h('div', { class: 'wrap page' }, emptyState('Landlord not found', e.message))); return; }
  const favs = await loadFavoriteIds();
  root.append(h('div', { class: 'wrap page' },
    h('div', { class: 'row gap', style: { marginBottom: '1.5rem' } }, avatar(p, 72), h('div', null, h('h1', { style: { fontSize: '2rem', margin: 0 } }, p.name),
      h('div', { class: 'row gap wrap-row', style: { marginTop: '.4rem' } }, p.verified ? verifiedBadge() : h('span', { class: 'chip chip-warn' }, 'Not yet verified'),
        p.rating_count ? h('span', { class: 'row gap-s' }, stars(p.rating, 16), `${p.rating} from ${plural(p.rating_count, 'rating')}`) : h('span', { class: 'muted' }, 'No ratings yet'),
        h('span', { class: 'muted' }, `Member since ${dateOnly(p.since)} · ${p.rented} rented through the platform`)))),
    p.bio ? h('p', { style: { maxWidth: '65ch', whiteSpace: 'pre-wrap' } }, p.bio) : null,
    h('h2', null, `Available now (${p.listings.length})`),
    p.listings.length ? h('div', { class: 'cards' }, p.listings.map((l) => listingCard(l, { favorites: favs }))) : h('p', { class: 'muted' }, 'No live listings right now.'),
    h('h2', { style: { marginTop: '2.5rem' } }, 'What tenants say'),
    p.reviews.length ? p.reviews.map((r) => h('article', { class: 'review' },
      h('div', { class: 'review-head' }, h('strong', null, r.author_name), stars(r.rating_landlord, 14), r.verified_visit ? h('span', { class: 'chip chip-ok' }, 'Visited') : null, h('span', { class: 'muted small' }, timeAgo(r.created_at))),
      h('p', { class: 'review-body' }, r.body), h('a', { class: 'small', href: `#/listing/${r.listing_id}` }, r.listing_title),
      r.reply ? h('div', { class: 'reply-box' }, h('strong', null, 'Landlord reply'), h('div', { class: 'review-body' }, r.reply)) : null)) : h('p', { class: 'muted' }, 'No reviews yet.')));
}

export async function profile(root) {
  if (!state.user) { location.hash = '/login'; return; }
  const u = state.user;
  const err = h('div', { class: 'form-error', hidden: true });
  const name = h('input', { type: 'text', value: u.name, maxlength: 80 });
  const phone = h('input', { type: 'tel', value: u.phone || '' });
  const bio = h('textarea', { maxlength: 600, style: { minHeight: '90px' } }, u.bio || '');
  let avatarPath = u.avatar;
  const preview = h('div'); const drawAvatar = () => clear(preview).append(avatar({ name: name.value, avatar: avatarPath }, 72));
  drawAvatar();
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const small = await shrinkImage(f, 600, 0.85); const r = await upload('avatar', small); avatarPath = r.path; drawAvatar(); } catch (ex) { fail(ex); }
  } });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  root.append(h('div', { class: 'wrap page page-narrow' }, h('h1', { style: { fontSize: '2rem' } }, 'Profile and settings'),
    h('section', { class: 'panel' }, err, h('div', { class: 'row gap', style: { marginBottom: '1rem' } }, preview, h('button', { class: 'btn btn-sm', onclick: () => file.click() }, icon('upload', 14), 'Change photo'), file),
      field('Name', name), field('Phone', phone, 'Shared with a landlord or tenant only after a viewing is confirmed.'),
      u.role === 'landlord' ? field('About you (shown on your landlord profile)', bio) : null,
      field('Email', h('input', { type: 'email', value: u.email, disabled: true })),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        try { await put0('/api/me', { name: name.value, phone: phone.value, bio: bio.value, avatar: avatarPath }); await refreshSession(); toast('Profile saved', 'success'); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      } }, 'Save profile')),
    h('section', { class: 'panel' }, h('h2', null, 'Change password'), field('Current password', cur), field('New password', nxt, 'At least 8 characters.'),
      h('button', { class: 'btn', onclick: async () => { try { await post('/api/me/password', { current: cur.value, next: nxt.value }); cur.value = nxt.value = ''; toast('Password changed', 'success'); } catch (ex) { fail(ex); } } }, 'Update password'))));
}
const put0 = (url, body) => import('../lib.js').then(({ api }) => api('PATCH', url, body));

export async function notifications(root) {
  if (!state.user) { location.hash = '/login'; return; }
  const { items } = await get('/api/notifications');
  await post('/api/notifications/read'); refreshCounters().then(() => import('../app.js').then((m) => m.renderHeader()));
  root.append(h('div', { class: 'wrap page page-narrow' }, h('h1', { style: { fontSize: '2rem' } }, 'Notifications'),
    items.length ? items.map((n) => h('a', { class: 'list-item', href: n.link || '#/', style: { textDecoration: 'none', color: 'inherit', borderLeft: n.read ? undefined : '4px solid var(--cobalt)' } },
      h('div', { class: 'grow' }, h('strong', null, n.title), n.body ? h('div', { class: 'small muted' }, n.body) : null), h('span', { class: 'small muted' }, timeAgo(n.created_at))))
      : emptyState('You are all caught up', 'Messages, viewing updates and review replies show up here.')));
}
