import { h, state, get, icon, emptyState } from '../lib.js';
import { listingCard, loadFavoriteIds } from '../cards.js';
import { heroPano } from '../tour.js';

export default async function home(root) {
  const pano = h('div', { class: 'pano-frame', 'aria-label': 'Live 360 degree preview of a sample room' });
  const input = h('input', { type: 'search', placeholder: 'Area, street or city, e.g. Yaba or Wuse', 'aria-label': 'Search location' });
  const go = (q) => { location.hash = '/search' + (q ? `?q=${encodeURIComponent(q)}` : ''); };
  const stats = h('div', { class: 'stats-line' });
  const featured = h('div', { class: 'cards' }, [1, 2, 3].map(() => h('div', { class: 'skeleton', style: { height: '320px' } })));

  root.append(
    h('section', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', null,
        h('h1', null, 'Walk through it before you walk to it.'),
        h('p', { class: 'hero-sub' }, 'Tour every room in 360° from your phone, message the landlord directly, and only travel for a viewing once you already like the place. No agent fees.'),
        h('form', { class: 'hero-search', onsubmit: (e) => { e.preventDefault(); go(input.value.trim()); } }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, icon('compass', 16), 'Search')),
        h('div', { class: 'hero-quick' }, ['Lagos', 'Abuja'].map((c) => h('a', { class: 'chip', href: `#/search?city=${c}` }, c)), h('a', { class: 'chip chip-tour', href: '#/search?tour=1&verified=1' }, 'Verified landlords with 360° tours')),
        stats),
      pano)),
    h('section', { class: 'section' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('h2', null, 'Ready to tour now'), h('a', { href: '#/search' }, 'See all places')), featured)),
    h('section', { class: 'section', style: { paddingTop: 0 } }, h('div', { class: 'wrap' },
      h('h2', null, 'How it works'),
      h('div', { class: 'steps' },
        h('div', { class: 'step' }, h('h3', null, 'Tour from anywhere'), h('p', { class: 'muted' }, 'Drag around each room in 360°, open VR mode on a headset, or watch the video walkthrough.')),
        h('div', { class: 'step' }, h('h3', null, 'Ask the landlord'), h('p', { class: 'muted' }, 'Message directly or post a question under the listing so everyone sees the answer. Read reviews from real tenants.')),
        h('div', { class: 'step' }, h('h3', null, 'Visit only if it fits'), h('p', { class: 'muted' }, 'Viewing requests unlock after you have toured every room. The exact address appears once the landlord confirms.'))))),
    h('section', { class: 'band section' }, h('div', { class: 'wrap row between wrap-row gap' },
      h('div', null, h('h2', null, 'Own a property? List it directly.'), h('p', { style: { color: '#c3cad6', maxWidth: '52ch', marginBottom: 0 } }, 'Shoot each room with your phone or a 360 camera, get verified, and meet serious tenants who have already toured the place.')),
      h('a', { class: 'btn btn-primary btn-lg', href: state.user?.role === 'landlord' ? '#/listing/new' : '#/register?role=landlord' }, 'Start listing'))));

  heroPano(pano, '/sample/pano_living_a.jpg', 'Drag to look around. This is what every listing tour feels like.');

  try {
    const [{ items, stats: s }, favs] = await Promise.all([get('/api/listings/featured'), loadFavoriteIds()]);
    stats.append(h('span', null, h('strong', null, s.listings), ' places live'), h('span', null, h('strong', null, s.verified_landlords), ' verified landlords'), h('span', null, h('strong', null, s.rooms), ' rooms to tour'));
    featured.replaceChildren(...(items.length ? items.map((l) => listingCard(l, { favorites: favs })) : [emptyState('No listings yet', 'Be the first landlord to list a place.')]));
  } catch { featured.replaceChildren(emptyState('Could not load listings', 'Please refresh.')); }
}
