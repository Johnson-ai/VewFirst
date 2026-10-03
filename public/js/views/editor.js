import {
  h, clear, state, get, post, put, del, icon, toast, fail, field, upload, shrinkImage, imageSize, dateTime, emptyState, confirmDialog,
} from '../lib.js';
import { ensureLeaflet } from './search.js';

export default async function editor(root, [id]) {
  if (!state.user) { location.hash = '/login'; return; }
  if (state.user.role === 'tenant') { root.append(h('div', { class: 'wrap page' }, emptyState('Landlord accounts only', 'Create a landlord account to list a property.', h('a', { class: 'btn btn-primary', href: '#/register?role=landlord' }, 'Sign up as landlord')))); return; }

  let L = {
    title: '', description: '', type: 'apartment', price: '', period: 'year', deposit: 0, service_charge: 0, beds: 1, baths: 1, size_sqm: '', furnished: false,
    amenities: [], city: '', area: '', address: '', lat: null, lng: null, available_from: '', min_lease_months: 12, rules: '', video: null, photos: [], rooms: [], status: 'draft',
  };
  if (id) {
    try {
      const got = await get(`/api/listings/${id}`);
      if (!got.is_owner) throw new Error('not owner');
      L = { ...L, ...got, photos: got.photos.map((p) => p.path), rooms: got.rooms.map((r) => ({ name: r.name, panorama: r.panorama })), size_sqm: got.size_sqm || '', available_from: got.available_from || '' };
      L.address = got.raw?.address ?? got.address ?? ''; L.lat = got.raw?.lat ?? got.lat; L.lng = got.raw?.lng ?? got.lng;
    } catch { root.append(h('div', { class: 'wrap page' }, emptyState('Listing not found', 'You can only edit your own listings.', h('a', { class: 'btn', href: '#/dashboard' }, 'Back to dashboard')))); return; }
  }
  let listingId = id ? Number(id) : null;
  const errBox = h('div', { class: 'form-error', hidden: true });
  const showErr = (m) => { errBox.textContent = m; errBox.hidden = !m; if (m) errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

  const bind = (key, props = {}) => h('input', { type: 'text', value: L[key] ?? '', ...props, oninput: (e) => { L[key] = e.target.value; } });
  const num = (key, props = {}) => h('input', { type: 'number', min: 0, inputmode: 'numeric', value: L[key] ?? '', ...props, oninput: (e) => { L[key] = e.target.value; } });

  // ---------------------------------------------------------------- basics
  const basics = h('section', { class: 'editor-sec', id: 'basics' }, h('h2', null, 'The basics'),
    field('Listing title', bind('title', { maxlength: 120, placeholder: 'Bright 2-bedroom flat in Yaba, close to the main road' }), 'Mention the size and the best feature. Avoid all-caps.'),
    h('div', { class: 'grid-2' },
      field('Property type', h('select', { onchange: (e) => (L.type = e.target.value) }, state.meta.listingTypes.map((t) => h('option', { value: t, selected: L.type === t }, t[0].toUpperCase() + t.slice(1))))),
      field('Floor area (m², optional)', num('size_sqm'))),
    h('div', { class: 'grid-3' }, field('Bedrooms (0 = studio)', num('beds', { max: 30 })), field('Bathrooms', num('baths', { max: 30 })),
      field('Furnished', h('select', { onchange: (e) => (L.furnished = e.target.value === '1') }, h('option', { value: '0', selected: !L.furnished }, 'Unfurnished'), h('option', { value: '1', selected: L.furnished }, 'Furnished')))),
    field('Description', h('textarea', { maxlength: 5000, style: { minHeight: '170px' }, oninput: (e) => (L.description = e.target.value) }, L.description),
      'Be specific about water, power, access, neighbours and what is not included. Honest listings get better tenants.'));

  // ---------------------------------------------------------------- pricing
  const cost = h('div', { class: 'small muted' });
  const drawCost = () => { const t = (Number(L.price) || 0) + (Number(L.deposit) || 0) + (Number(L.service_charge) || 0); cost.textContent = t ? `Tenants will see a move-in total of ${new Intl.NumberFormat(state.meta.locale).format(t)} ${state.meta.currency}.` : ''; };
  const pricing = h('section', { class: 'editor-sec', id: 'pricing' }, h('h2', null, 'Rent and costs'),
    h('div', { class: 'grid-2' },
      field(`Rent (${state.meta.currency})`, num('price', { oninput: (e) => { L.price = e.target.value; drawCost(); } })),
      field('Paid', h('select', { onchange: (e) => (L.period = e.target.value) }, h('option', { value: 'year', selected: L.period === 'year' }, 'Per year'), h('option', { value: 'month', selected: L.period === 'month' }, 'Per month')))),
    h('div', { class: 'grid-3' },
      field('Refundable deposit', num('deposit', { oninput: (e) => { L.deposit = e.target.value; drawCost(); } })),
      field('Service charge', num('service_charge', { oninput: (e) => { L.service_charge = e.target.value; drawCost(); } })),
      field('Minimum lease (months)', num('min_lease_months', { min: 1 }))),
    h('div', { class: 'grid-2' }, field('Available from', h('input', { type: 'date', value: L.available_from || '', oninput: (e) => (L.available_from = e.target.value) }))),
    h('p', { class: 'small muted' }, 'This platform does not charge tenants an agent fee, so do not add one here. Tenants see the full move-in cost up front.'), cost);
  drawCost();

  // ---------------------------------------------------------------- location
  const mapBox = h('div', { class: 'picker-map' });
  const latIn = num('lat', { step: 'any', min: -90 }); const lngIn = num('lng', { step: 'any', min: -180 });
  let marker = null; let pickMap = null;
  const setPoint = (lat, lng, pan) => {
    L.lat = Number(lat.toFixed(6)); L.lng = Number(lng.toFixed(6)); latIn.value = L.lat; lngIn.value = L.lng;
    if (pickMap) { if (marker) marker.setLatLng([L.lat, L.lng]); else marker = window.L.marker([L.lat, L.lng]).addTo(pickMap); if (pan) pickMap.setView([L.lat, L.lng], 16); }
  };
  const locationSec = h('section', { class: 'editor-sec', id: 'location' }, h('h2', null, 'Location'),
    h('div', { class: 'grid-2' }, field('City', bind('city', { placeholder: 'Lagos' })), field('Area / neighbourhood', bind('area', { placeholder: 'Yaba' }), 'Shown publicly.')),
    field('Full street address', bind('address', { placeholder: 'House number and street' }), 'Hidden from the public. Tenants only see it after you confirm their viewing.'),
    h('div', { class: 'row gap wrap-row' }, h('span', { class: 'field-label', style: { margin: 0 } }, 'Pin on the map'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => navigator.geolocation?.getCurrentPosition((p) => setPoint(p.coords.latitude, p.coords.longitude, true), () => toast('Could not get your location. Click the map instead.', 'error')) }, icon('compass', 14), 'Use my current location')),
    mapBox, h('div', { class: 'grid-2' }, field('Latitude', latIn), field('Longitude', lngIn)),
    h('p', { class: 'small muted' }, 'Click the map to drop the pin. Public visitors only see an approximate area (about a 350 m circle).'));

  // ---------------------------------------------------------------- photos
  const thumbs = h('div', { class: 'thumbs' });
  const drawPhotos = () => {
    clear(thumbs);
    L.photos.forEach((p, i) => thumbs.append(h('div', { class: `thumb ${i === 0 ? 'cover' : ''}` }, h('img', { src: p, alt: '' }),
      h('div', { class: 'thumb-actions' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move earlier', disabled: i === 0, onclick: () => { [L.photos[i - 1], L.photos[i]] = [L.photos[i], L.photos[i - 1]]; drawPhotos(); } }, icon('left', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove photo', onclick: () => { L.photos.splice(i, 1); drawPhotos(); } }, icon('trash', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move later', disabled: i === L.photos.length - 1, onclick: () => { [L.photos[i + 1], L.photos[i]] = [L.photos[i], L.photos[i + 1]]; drawPhotos(); } }, icon('right', 16))))));
  };
  const photoStatus = h('div', { class: 'small muted' });
  async function addPhotos(files) {
    for (const f of files) {
      try {
        photoStatus.textContent = `Uploading ${f.name}…`;
        const small = await shrinkImage(f, 1800, 0.85);
        const r = await upload('photo', small); L.photos.push(r.path); drawPhotos();
      } catch (e) { fail(e); }
    }
    photoStatus.textContent = '';
  }
  const photoInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true, onchange: (e) => { addPhotos([...e.target.files]); e.target.value = ''; } });
  const photoDrop = dropzone('Add photos', 'The first photo is the cover. Good light, wide angle, tidy rooms.', photoInput, addPhotos);
  const photosSec = h('section', { class: 'editor-sec', id: 'photos' }, h('h2', null, 'Photos'), photoDrop, photoInput, photoStatus, thumbs); drawPhotos();

  // ---------------------------------------------------------------- 360 rooms
  const roomList = h('div');
  const drawRooms = () => {
    clear(roomList);
    if (!L.rooms.length) roomList.append(h('p', { class: 'muted small' }, 'No rooms yet. Add at least one 360° room, or a video walkthrough below.'));
    L.rooms.forEach((r, i) => roomList.append(h('div', { class: 'room-row' }, h('img', { src: r.panorama, alt: '' }),
      h('input', { type: 'text', value: r.name, maxlength: 60, 'aria-label': 'Room name', oninput: (e) => (r.name = e.target.value) }),
      h('div', { class: 'row gap-s' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move earlier', disabled: i === 0, onclick: () => { [L.rooms[i - 1], L.rooms[i]] = [L.rooms[i], L.rooms[i - 1]]; drawRooms(); } }, icon('left', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move later', disabled: i === L.rooms.length - 1, onclick: () => { [L.rooms[i + 1], L.rooms[i]] = [L.rooms[i], L.rooms[i + 1]]; drawRooms(); } }, icon('right', 16)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove room', onclick: () => { L.rooms.splice(i, 1); drawRooms(); } }, icon('trash', 16))))));
  };
  const roomStatus = h('div', { class: 'small' });
  async function addRooms(files) {
    for (const f of files) {
      try {
        const dims = await imageSize(f);
        const ratio = dims.w && dims.h ? dims.w / dims.h : 0;
        roomStatus.className = 'small muted'; roomStatus.textContent = `Preparing ${f.name}…`;
        const small = await shrinkImage(f, 6000, 0.84);
        roomStatus.textContent = `Uploading ${f.name}…`;
        const r = await upload('pano', small);
        const base = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 40) || `Room ${L.rooms.length + 1}`;
        L.rooms.push({ name: base[0].toUpperCase() + base.slice(1), panorama: r.path });
        if (ratio && ratio < 1.9) toast(`"${base}" is not a full 2:1 panorama. It will show as a partial wide view, which works but feels less immersive.`);
        drawRooms();
      } catch (e) { fail(e); }
    }
    roomStatus.textContent = '';
  }
  const roomInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true, onchange: (e) => { addRooms([...e.target.files]); e.target.value = ''; } });
  const roomsSec = h('section', { class: 'editor-sec', id: 'rooms' }, h('h2', null, '360° room tour'),
    h('p', { class: 'muted' }, 'Shoot each room with your phone\'s panorama or photo-sphere mode, or a 360 camera (about $100). Upload the equirectangular (2:1) image. Photos are resized in your browser to keep the tour fast on slow connections. Name each room, and put them in the order a visitor would walk through.'),
    dropzone('Add 360° photos', 'JPG, PNG or WebP. One image per room.', roomInput, addRooms), roomInput, roomStatus, roomList); drawRooms();

  // ---------------------------------------------------------------- video
  const videoHost = h('div');
  const drawVideo = () => {
    clear(videoHost);
    if (L.video) videoHost.append(h('video', { src: L.video, controls: true, style: { maxWidth: '420px', width: '100%', borderRadius: '6px' } }), h('div', null, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { L.video = null; drawVideo(); } }, icon('trash', 14), 'Remove video')));
  };
  const vProg = h('div', { class: 'progress', hidden: true }, h('i'));
  const videoInput = h('input', { type: 'file', accept: 'video/mp4,video/webm', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    if (f.size > state.meta.limits.video * 1024 * 1024) return toast(`Videos must be under ${state.meta.limits.video} MB. Trim it or lower the resolution to 720p.`, 'error');
    vProg.hidden = false;
    try { const r = await upload('video', f, (p) => (vProg.firstChild.style.width = `${p * 100}%`)); L.video = r.path; drawVideo(); } catch (err) { fail(err); }
    vProg.hidden = true;
  } });
  const videoSec = h('section', { class: 'editor-sec', id: 'video' }, h('h2', null, 'Video walkthrough (optional)'),
    h('p', { class: 'muted' }, `A short MP4 or WebM, up to ${state.meta.limits.video} MB. Useful as a fallback for people on slow connections and for outdoor areas. Keep it under two minutes.`),
    h('button', { class: 'btn', type: 'button', onclick: () => videoInput.click() }, icon('upload', 16), L.video ? 'Replace video' : 'Upload video'), videoInput, vProg, videoHost); drawVideo();

  // ---------------------------------------------------------------- amenities + rules
  const amenitySec = h('section', { class: 'editor-sec', id: 'amenities' }, h('h2', null, 'Amenities and rules'),
    h('div', { class: 'tag-grid' }, state.meta.amenities.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: L.amenities.includes(a), onchange: (e) => { L.amenities = e.target.checked ? [...L.amenities, a] : L.amenities.filter((x) => x !== a); } }), a))),
    h('div', { style: { marginTop: '1rem' } }, field('House rules', h('textarea', { maxlength: 1500, style: { minHeight: '90px' }, oninput: (e) => (L.rules = e.target.value) }, L.rules))));

  // ---------------------------------------------------------------- viewing slots
  const slotsHost = h('div');
  async function drawSlots() {
    if (!listingId) { clear(slotsHost).append(h('p', { class: 'muted' }, 'Save the listing first, then add the times you are free to show it.')); return; }
    const { slots } = await get(`/api/listings/${listingId}/slots`);
    clear(slotsHost);
    const dt = h('input', { type: 'datetime-local' });
    const dur = h('select', null, [20, 30, 45, 60].map((m) => h('option', { value: m, selected: m === 30 }, `${m} min`)));
    slotsHost.append(h('div', { class: 'row gap wrap-row', style: { alignItems: 'flex-end' } },
      field('Date and time', dt), field('Length', dur),
      h('button', { class: 'btn btn-primary', type: 'button', style: { marginBottom: '1rem' }, onclick: async () => { if (!dt.value) return toast('Pick a date and time.', 'error'); try { await post(`/api/listings/${listingId}/slots`, { times: [new Date(dt.value).toISOString()], duration_min: Number(dur.value) }); drawSlots(); } catch (e) { fail(e); } } }, 'Add time'),
      h('button', { class: 'btn', type: 'button', style: { marginBottom: '1rem' }, onclick: async () => {
        const times = [];
        for (let d = 2; d <= 8; d++) for (const hr of [10, 14, 16]) { const t = new Date(); t.setDate(t.getDate() + d); t.setHours(hr, 0, 0, 0); if (t.getDay() !== 0) times.push(t.toISOString()); }
        try { const r = await post(`/api/listings/${listingId}/slots`, { times, duration_min: 30 }); toast(`${r.added} times added (Mon–Sat, 10:00, 14:00, 16:00)`, 'success'); drawSlots(); } catch (e) { fail(e); }
      } }, 'Quick add next week')));
    if (!slots.length) slotsHost.append(h('p', { class: 'muted small' }, 'No upcoming slots. Tenants cannot request a viewing until you add some.'));
    slotsHost.append(h('div', { class: 'row wrap-row gap-s' }, slots.map((s) => h('span', { class: `chip ${s.status === 'open' ? '' : s.status === 'held' ? 'chip-warn' : 'chip-ok'}` }, dateTime(s.starts_at), s.status !== 'open' ? ` · ${s.status}` : '',
      s.status === 'open' ? h('button', { class: 'icon-btn', style: { padding: 0 }, 'aria-label': 'Delete slot', onclick: async () => { try { await del(`/api/slots/${s.id}`); drawSlots(); } catch (e) { fail(e); } } }, icon('close', 12)) : null))));
  }
  const slotsSec = h('section', { class: 'editor-sec', id: 'slots' }, h('h2', null, 'Viewing times'), h('p', { class: 'muted' }, 'Tenants can only request one of these times, and only after they have toured every room.'), slotsHost);

  // ---------------------------------------------------------------- actions
  const payload = () => ({
    title: L.title, description: L.description, type: L.type, price: L.price === '' ? 0 : Number(L.price), period: L.period, deposit: Number(L.deposit) || 0, service_charge: Number(L.service_charge) || 0,
    beds: Number(L.beds) || 0, baths: Number(L.baths) || 0, size_sqm: L.size_sqm === '' ? null : Number(L.size_sqm), furnished: !!L.furnished, amenities: L.amenities, city: L.city, area: L.area, address: L.address,
    lat: L.lat === '' || L.lat == null ? null : Number(L.lat), lng: L.lng === '' || L.lng == null ? null : Number(L.lng), available_from: L.available_from || null,
    min_lease_months: Number(L.min_lease_months) || 12, rules: L.rules, video: L.video, photos: L.photos, rooms: L.rooms.map((r) => ({ name: r.name, panorama: r.panorama })),
  });
  async function save(publish) {
    showErr('');
    try {
      if (listingId) await put(`/api/listings/${listingId}`, payload());
      else { const r = await post('/api/listings', payload()); listingId = r.id; history.replaceState(null, '', `#/listing/${listingId}/edit`); drawSlots(); }
      if (publish) { await post(`/api/listings/${listingId}/status`, { status: 'published' }); toast('Your listing is live', 'success'); location.hash = `/listing/${listingId}`; }
      else toast('Saved', 'success');
    } catch (e) { showErr(e.message); }
  }

  root.append(h('div', { class: 'wrap page' },
    h('div', { class: 'row between wrap-row gap', style: { marginBottom: '1.25rem' } }, h('h1', { style: { fontSize: '2rem', margin: 0 } }, id ? 'Edit listing' : 'New listing'),
      h('div', { class: 'row gap-s' }, listingId ? h('a', { class: 'btn', href: `#/listing/${listingId}` }, 'Preview') : null,
        h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, 'Save'),
        L.status === 'published' ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save(true) }, 'Save and publish'))),
    state.user.verified_status !== 'verified' && state.meta.requireVerification ? h('div', { class: 'notice', style: { marginBottom: '1rem' } }, h('strong', null, 'Verification needed to publish. '), 'You can build the listing now. ', h('a', { href: '#/dashboard' }, 'Submit your documents'), ' to go live with the verified badge.') : null,
    errBox,
    h('div', { class: 'editor-grid' },
      h('nav', { class: 'editor-nav', 'aria-label': 'Sections' }, [['basics', 'Basics'], ['pricing', 'Rent and costs'], ['location', 'Location'], ['photos', 'Photos'], ['rooms', '360° rooms'], ['video', 'Video'], ['amenities', 'Amenities'], ['slots', 'Viewing times']].map(([k, l]) => h('a', { href: `#/listing/${id || 'new'}${id ? '/edit' : ''}`.replace('#', '#'), onclick: (e) => { e.preventDefault(); document.getElementById(k)?.scrollIntoView({ behavior: 'smooth' }); } }, l))),
      h('div', null, basics, pricing, locationSec, photosSec, roomsSec, videoSec, amenitySec, slotsSec,
        h('div', { class: 'row end gap' }, h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, 'Save'), L.status === 'published' ? null : h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => save(true) }, 'Save and publish'))))));

  drawSlots();
  try {
    await ensureLeaflet();
    const c = L.lat != null ? [Number(L.lat), Number(L.lng)] : state.meta.mapCenter;
    pickMap = window.L.map(mapBox).setView(c, L.lat != null ? 16 : 11);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(pickMap);
    if (L.lat != null) marker = window.L.marker([Number(L.lat), Number(L.lng)]).addTo(pickMap);
    pickMap.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng, false));
  } catch { mapBox.append(h('div', { class: 'map-fallback' }, 'The map could not load. Enter the latitude and longitude below instead.')); }

  return () => { try { pickMap?.remove(); } catch { /* ignore */ } };
}

function dropzone(title, sub, input, onFiles) {
  const dz = h('div', { class: 'dropzone', tabindex: '0', role: 'button', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    ondragover: (e) => { e.preventDefault(); dz.classList.add('over'); }, ondragleave: () => dz.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); dz.classList.remove('over'); onFiles([...e.dataTransfer.files]); } },
  h('strong', null, icon('upload', 16), ' ', title), h('div', { class: 'small' }, sub));
  return dz;
}
