import { h, icon, state, post, del, toast, fail, priceLabel, money, stars, verifiedBadge, plural, cap } from './lib.js';

export function listingCard(l, { favorites = null, onFavChange } = {}) {
  const fav = favorites && favorites.has(l.id);
  const favBtn = h('button', {
    class: `card-fav ${fav ? 'on' : ''}`, 'aria-label': fav ? 'Remove from saved' : 'Save this place', 'aria-pressed': !!fav,
    onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!state.user) { toast('Log in to save places'); location.hash = '/login'; return; }
      const on = favBtn.classList.contains('on');
      try {
        if (on) await del(`/api/listings/${l.id}/favorite`); else await post(`/api/listings/${l.id}/favorite`);
        favBtn.classList.toggle('on', !on); favBtn.setAttribute('aria-pressed', String(!on));
        if (favorites) { if (on) favorites.delete(l.id); else favorites.add(l.id); }
        onFavChange?.(l, !on);
      } catch (err) { fail(err); }
    },
  }, icon('heart', 18));

  const tourLabel = l.rooms ? `${plural(l.rooms, 'room')} in 360°` : (l.has_video ? 'Video tour' : null);
  return h('article', { class: `card ${l.status === 'rented' ? 'is-rented' : ''}` },
    h('div', { class: 'card-media' },
      l.cover ? h('img', { src: l.cover, alt: '', loading: 'lazy', decoding: 'async' }) : null,
      tourLabel ? h('span', { class: 'chip chip-tour' }, icon('vr', 14), tourLabel) : null,
      favBtn),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-price' }, money(l.price), ' ', h('small', null, `/ ${l.period === 'month' ? 'month' : 'year'}`)),
      h('h3', { class: 'card-title' }, h('a', { href: `#/listing/${l.id}` }, l.title)),
      h('div', { class: 'card-facts' },
        h('span', null, icon('bed', 15), l.beds === 0 ? 'Studio' : plural(l.beds, 'bed')),
        h('span', null, icon('bath', 15), plural(l.baths, 'bath')),
        h('span', null, cap(l.type)), l.furnished ? h('span', null, 'Furnished') : null),
      h('div', { class: 'card-foot' },
        h('span', null, icon('pin', 14), ` ${[l.area, l.city].filter(Boolean).join(', ')}`),
        l.owner.verified ? verifiedBadge('Verified') : h('span', { class: 'muted small' }, 'Not yet verified')),
      l.n_property ? h('div', { class: 'row gap-s small muted' }, stars(l.avg_property, 14), ` ${l.avg_property} (${l.n_property})`) : null,
      l.status === 'rented' ? h('span', { class: 'chip chip-warn' }, 'Rented') : null));
}

export async function loadFavoriteIds() {
  if (!state.user) return new Set();
  try { const { get } = await import('./lib.js'); const r = await get('/api/favorites'); return new Set(r.items.map((i) => i.id)); } catch { return new Set(); }
}
