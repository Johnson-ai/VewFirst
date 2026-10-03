import { h, clear, state, get, icon, emptyState, loadScript, loadCss, money, priceLabel, plural } from '../lib.js';
import { listingCard, loadFavoriteIds } from '../cards.js';

const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
export const ensureLeaflet = async () => { loadCss(LEAFLET_CSS); if (!window.L) await loadScript(LEAFLET_JS); };

export default async function search(root, _p, query) {
  const f = {
    q: query.get('q') || '', city: query.get('city') || '', type: query.get('type') || '', beds: query.get('beds') || '', min_price: query.get('min_price') || '',
    max_price: query.get('max_price') || '', period: query.get('period') || '', sort: query.get('sort') || 'newest', verified: query.get('verified') === '1',
    tour: query.get('tour') === '1', furnished: query.get('furnished') === '1', amenity: query.getAll('amenity'), page: Number(query.get('page')) || 1, view: query.get('view') || 'list',
  };
  const favs = await loadFavoriteIds();
  let map = null; let markers = null; let aborter = null;

  const inp = (key, props = {}) => h('input', { type: 'text', value: f[key], ...props, oninput: (e) => { f[key] = e.target.value; } });
  const sel = (key, options) => h('select', { onchange: (e) => { f[key] = e.target.value; apply(); } }, options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const chk = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f[key], onchange: (e) => { f[key] = e.target.checked; apply(); } }), label);
  const amenityBox = h('div', { class: 'amenity-grid', hidden: !f.amenity.length },
    state.meta.amenities.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.amenity.includes(a), onchange: (e) => { f.amenity = e.target.checked ? [...f.amenity, a] : f.amenity.filter((x) => x !== a); apply(); } }), a)));

  const form = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); f.page = 1; apply(); } },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Where'), inp('q', { placeholder: 'Area, street or keyword', type: 'search' })),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'City'), inp('city', { placeholder: 'Any' })),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type'), sel('type', [['', 'Any type'], ...state.meta.listingTypes.map((t) => [t, t[0].toUpperCase() + t.slice(1)])])),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bedrooms'), sel('beds', [['', 'Any'], ['1', '1+'], ['2', '2+'], ['3', '3+'], ['4', '4+']])),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Min price'), inp('min_price', { inputmode: 'numeric', placeholder: '0' })),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Max price'), inp('max_price', { inputmode: 'numeric', placeholder: 'Any' })),
    h('button', { type: 'submit', hidden: true }));

  const more = h('div', { class: 'filter-more' },
    chk('verified', 'Verified landlords only'), chk('tour', 'Has a virtual tour'), chk('furnished', 'Furnished'),
    h('label', { class: 'field', style: { margin: 0 } }, sel('period', [['', 'Rent: any period'], ['year', 'Paid yearly'], ['month', 'Paid monthly']])),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => amenityBox.toggleAttribute('hidden') }, icon('filter', 14), 'Amenities'),
    h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { f.page = 1; apply(); } }, 'Search'),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { location.hash = '/search'; } }, 'Clear all'));

  const head = h('div', { class: 'results-head' });
  const body = h('div');
  const view = h('div', { class: 'wrap' }, head, body);
  root.append(h('div', { class: 'search-bar' }, h('div', { class: 'wrap' }, form, more, amenityBox)), view);

  function toHash() {
    const p = new URLSearchParams();
    for (const k of ['q', 'city', 'type', 'beds', 'min_price', 'max_price', 'period']) if (f[k]) p.set(k, f[k]);
    if (f.sort !== 'newest') p.set('sort', f.sort);
    for (const k of ['verified', 'tour', 'furnished']) if (f[k]) p.set(k, '1');
    f.amenity.forEach((a) => p.append('amenity', a));
    if (f.page > 1) p.set('page', f.page);
    if (f.view === 'map') p.set('view', 'map');
    return '/search' + (p.toString() ? '?' + p : '');
  }
  const apply = () => { const next = toHash(); if (location.hash.slice(1) === next) load(); else location.hash = next; };

  async function load() {
    aborter?.abort(); aborter = new AbortController();
    const p = new URLSearchParams(toHash().split('?')[1] || '');
    p.delete('view'); p.set('limit', f.view === 'map' ? 100 : 12);
    clear(body).append(h('div', { class: 'cards' }, [1, 2, 3].map(() => h('div', { class: 'skeleton', style: { height: '320px' } }))));
    let data;
    try { data = await get('/api/listings?' + p, { signal: aborter.signal }); } catch (e) { if (e.name === 'AbortError') return; clear(body).append(emptyState('Search failed', e.message)); return; }

    clear(head).append(
      h('div', null, h('h2', { style: { margin: 0 } }, plural(data.total, 'place'), ' found'), h('span', { class: 'muted small' }, 'Exact addresses unlock after a landlord confirms your viewing.')),
      h('div', { class: 'row gap wrap-row' },
        h('label', { class: 'row gap-s small' }, 'Sort', sel('sort', [['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['rating', 'Best rated']])),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Result layout' },
          h('button', { class: f.view === 'list' ? 'on' : '', onclick: () => { f.view = 'list'; apply(); } }, icon('list', 16), 'List'),
          h('button', { class: f.view === 'map' ? 'on' : '', onclick: () => { f.view = 'map'; apply(); } }, icon('map', 16), 'Map'))));

    clear(body);
    if (!data.items.length) { body.append(emptyState('Nothing matches yet', 'Try removing a filter or widening the price range.', h('a', { class: 'btn', href: '#/search' }, 'Clear filters'))); return; }
    const cards = h('div', { class: 'cards' }, data.items.map((l) => listingCard(l, { favorites: favs })));
    if (f.view === 'map') {
      const box = h('div', { class: 'map-box', id: 'result-map' });
      body.append(h('div', { class: 'map-layout' }, cards, box));
      try { await ensureLeaflet(); drawMap(box, data.items); } catch { box.append(h('div', { class: 'map-fallback' }, 'The map needs an internet connection to load.')); }
    } else {
      body.append(cards);
      if (data.pages > 1) body.append(h('div', { class: 'pager' },
        h('button', { class: 'btn', disabled: f.page <= 1, onclick: () => { f.page--; apply(); } }, 'Previous'), `Page ${data.page} of ${data.pages}`,
        h('button', { class: 'btn', disabled: f.page >= data.pages, onclick: () => { f.page++; apply(); } }, 'Next')));
    }
  }

  function drawMap(box, items) {
    map = window.L.map(box, { scrollWheelZoom: true });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const pts = [];
    for (const l of items) {
      if (l.lat == null) continue;
      const pin = window.L.divIcon({ className: '', html: `<div class="price-pin ${l.owner.verified ? 'v' : ''}"></div>`, iconSize: [0, 0] });
      const m = window.L.marker([l.lat, l.lng], { icon: pin }).addTo(map);
      m.getElement().firstChild.textContent = money(l.price);
      const pop = h('div', { class: 'map-pop' }, l.cover ? h('img', { src: l.cover, alt: '' }) : null, h('strong', null, priceLabel(l)), h('div', null, l.title), h('a', { href: `#/listing/${l.id}` }, 'Open listing'));
      m.bindPopup(pop);
      pts.push([l.lat, l.lng]);
    }
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 }); else map.setView(state.meta.mapCenter, 11);
    setTimeout(() => map.invalidateSize(), 50);
  }

  await load();
  return () => { aborter?.abort(); try { map?.remove(); } catch { /* ignore */ } };
}
