import { h, clear, state, get, post, icon, toast, fail, confirmDialog, dateTime, emptyState, cap } from '../lib.js';

export default async function viewings(root) {
  if (!state.user) { location.hash = '/login'; return; }
  const host = h('div', { class: 'wrap page' });
  root.append(host);
  let tab = 'upcoming';

  async function draw() {
    const { items } = await get('/api/viewings');
    const now = Date.now();
    const upcoming = items.filter((v) => ['requested', 'confirmed'].includes(v.status) && new Date(v.starts_at).getTime() > now - 3600_000);
    const past = items.filter((v) => !upcoming.includes(v));
    const list = tab === 'upcoming' ? upcoming.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : past;
    clear(host).append(h('h1', { style: { fontSize: '2rem' } }, 'Viewings'),
      h('div', { class: 'tabs', role: 'tablist' }, [['upcoming', `Upcoming (${upcoming.length})`], ['past', `Past and closed (${past.length})`]].map(([k, l]) => h('button', { class: tab === k ? 'on' : '', role: 'tab', onclick: () => { tab = k; draw(); } }, l))),
      ...(list.length ? list.map((v) => card(v)) : [emptyState(tab === 'upcoming' ? 'No upcoming viewings' : 'Nothing here yet', tab === 'upcoming' ? 'Tour a place in 360°, then request a viewing from its page.' : null, tab === 'upcoming' ? h('a', { class: 'btn btn-primary', href: '#/search' }, 'Find a place') : null)]));
  }

  async function act(v, status, title, text) {
    if (title && !(await confirmDialog(title, text, 'Yes', status === 'cancelled' || status === 'declined'))) return;
    try { await post(`/api/viewings/${v.id}/status`, { status }); toast('Updated', 'success'); draw(); } catch (e) { fail(e); }
  }

  function card(v) {
    const mineAsLandlord = v.role === 'landlord';
    const other = mineAsLandlord ? v.tenant : v.landlord;
    const chip = { requested: 'chip-warn', confirmed: 'chip-ok', completed: 'chip-ok', declined: 'chip-bad', cancelled: 'chip-bad' }[v.status];
    const past = new Date(v.starts_at).getTime() < Date.now();
    return h('article', { class: 'list-item' },
      h('div', { class: 'grow' },
        h('div', { class: 'row gap wrap-row' }, h('strong', null, dateTime(v.starts_at)), h('span', { class: `chip ${chip}` }, cap(v.status)), h('span', { class: 'muted small' }, `${v.duration_min} min`)),
        h('div', null, h('a', { href: `#/listing/${v.listing_id}` }, v.listing_title), h('span', { class: 'muted' }, ` · ${v.area}, ${v.city}`)),
        h('div', { class: 'small muted' }, mineAsLandlord ? `Tenant: ${other.name}` : `Landlord: ${other.name}`, other.phone ? ` · ${other.phone}` : ''),
        v.address ? h('div', { class: 'small' }, icon('pin', 14), ` ${v.address}`) : null,
        v.note ? h('div', { class: 'small', style: { fontStyle: 'italic' } }, `“${v.note}”`) : null),
      h('div', { class: 'row gap-s wrap-row' },
        mineAsLandlord && v.status === 'requested' ? [h('button', { class: 'btn btn-sm btn-primary', onclick: () => act(v, 'confirmed') }, 'Confirm'), h('button', { class: 'btn btn-sm', onclick: () => act(v, 'declined', 'Decline this request?', 'The time slot opens up again for other tenants.') }, 'Decline')] : null,
        mineAsLandlord && v.status === 'confirmed' && past ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => act(v, 'completed') }, 'Mark completed') : null,
        ['requested', 'confirmed'].includes(v.status) ? h('button', { class: 'btn btn-sm', onclick: () => act(v, 'cancelled', 'Cancel this viewing?', `${other.name} will be notified.`) }, 'Cancel') : null,
        ['confirmed', 'completed'].includes(v.status) ? h('a', { class: 'btn btn-sm', href: `/api/viewings/${v.id}/ics` }, icon('calendar', 14), 'Add to calendar') : null,
        h('a', { class: 'btn btn-sm', href: `#/listing/${v.listing_id}` }, 'Open listing')));
  }

  await draw();
}
