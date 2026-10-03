import { h, clear, state, get, post, del, icon, toast, fail, modal, confirmDialog, field, upload, shrinkImage, money, priceLabel, plural, dateTime, emptyState, verifiedBadge, cap } from '../lib.js';
import { refreshSession } from '../app.js';

const ID_TYPES = [['national_id', 'National ID card'], ['passport', 'International passport'], ['drivers_license', "Driver's licence"], ['voters_card', "Voter's card"], ['other', 'Other government ID']];

export default async function dashboard(root) {
  if (!state.user) { location.hash = '/login'; return; }
  if (state.user.role !== 'landlord' && state.user.role !== 'admin') { location.hash = '/viewings'; return; }
  const host = h('div', { class: 'wrap page' });
  root.append(host);

  async function draw() {
    const [stats, mine, ver] = await Promise.all([get('/api/my/stats'), get('/api/my/listings'), state.user.role === 'landlord' ? get('/api/verification') : Promise.resolve(null)]);
    clear(host).append(
      h('div', { class: 'row between wrap-row gap', style: { marginBottom: '1.25rem' } }, h('h1', { style: { fontSize: '2rem', margin: 0 } }, 'My listings'),
        h('a', { class: 'btn btn-primary', href: '#/listing/new' }, icon('plus', 16), 'New listing')),
      ver ? verificationPanel(ver) : null,
      h('div', { class: 'stat-row' },
        stat(stats.listings, 'live listings'), stat(stats.views, 'listing views'), stat(stats.saves, 'saves'), stat(stats.inquiries, 'conversations'),
        h('a', { class: 'stat', href: '#/viewings', style: { textDecoration: 'none', color: 'inherit', borderColor: stats.pending_viewings ? 'var(--marigold)' : undefined } }, h('b', null, stats.pending_viewings), h('span', null, `viewing requests waiting · ${stats.upcoming_viewings} upcoming`)),
        stat(stats.rating.avg ? `${stats.rating.avg} ★` : '–', stats.rating.n ? `landlord rating (${stats.rating.n})` : 'no ratings yet')),
      mine.items.length ? table(mine.items) : emptyState('No listings yet', 'Add your first property. A phone and ten minutes per room is all you need.', h('a', { class: 'btn btn-primary', href: '#/listing/new' }, 'Create a listing')));
  }

  const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, label));

  function table(items) {
    const statusChip = (s) => h('span', { class: `chip ${s === 'published' ? 'chip-ok' : s === 'rented' ? 'chip-warn' : ''}` }, cap(s));
    return h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Listing', 'Status', 'Rent', 'Views', 'Tour visitors', 'Saves', 'Chats', ''].map((t) => h('th', null, t)))),
      h('tbody', null, items.map((l) => h('tr', null,
        h('td', null, h('a', { href: `#/listing/${l.id}`, style: { fontWeight: 600 } }, l.title), h('div', { class: 'small muted' }, `${l.area}, ${l.city} · ${plural(l.rooms, 'room')}`)),
        h('td', null, statusChip(l.status), l.pending_viewings ? h('div', null, h('a', { class: 'small', href: '#/viewings' }, `${l.pending_viewings} viewing request${l.pending_viewings > 1 ? 's' : ''}`)) : null),
        h('td', null, priceLabel(l)), h('td', null, l.views), h('td', null, l.tour_visitors), h('td', null, l.saves), h('td', null, l.inquiries),
        h('td', null, h('div', { class: 'row gap-s wrap-row' },
          h('a', { class: 'btn btn-sm', href: `#/listing/${l.id}/edit` }, 'Edit'),
          l.status === 'published' ? h('button', { class: 'btn btn-sm', onclick: () => setStatus(l, 'rented', 'Mark as rented?', 'It will show as rented and people who saved it get notified.') }, 'Mark rented') : null,
          l.status === 'published' ? h('button', { class: 'btn btn-sm', onclick: () => setStatus(l, 'draft') }, 'Unpublish') : null,
          l.status !== 'published' && l.status !== 'removed' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => setStatus(l, 'published') }, 'Publish') : null,
          h('button', { class: 'icon-btn', 'aria-label': 'Delete listing', onclick: async () => { if (await confirmDialog('Delete listing', `"${l.title}" and its reviews, comments and bookings will be permanently deleted.`, 'Delete', true)) { try { await del(`/api/listings/${l.id}`); toast('Deleted'); draw(); } catch (e) { fail(e); } } } }, icon('trash', 16)))))))));
  }

  async function setStatus(l, status, title, text) {
    if (title && !(await confirmDialog(title, text, 'Yes'))) return;
    try { await post(`/api/listings/${l.id}/status`, { status }); toast('Updated', 'success'); draw(); } catch (e) { modal('Cannot do that yet', (b, close) => { b.append(h('p', null, e.message), h('div', { class: 'row end' }, h('button', { class: 'btn btn-primary', onclick: close }, 'OK'))); }); }
  }

  function verificationPanel(v) {
    const s = state.user.verified_status;
    if (s === 'verified') return h('div', { class: 'panel', style: { marginBottom: '1.25rem' } }, h('div', { class: 'row gap' }, verifiedBadge(), h('span', { class: 'muted' }, 'Your identity and ownership documents were approved. The badge shows on all your listings.')));
    if (s === 'pending') return h('div', { class: 'notice', style: { marginBottom: '1.25rem' } }, h('strong', null, 'Verification in review. '), 'We usually respond within two working days. You can keep building listings meanwhile.');
    return h('div', { class: 'panel', style: { marginBottom: '1.25rem', borderColor: 'var(--marigold)' } },
      h('h3', null, s === 'rejected' ? 'Verification needs changes' : 'Get verified to publish'),
      s === 'rejected' && v.latest?.reason ? h('div', { class: 'form-error' }, v.latest.reason) : null,
      h('p', { class: 'muted' }, 'Tenants trust verified landlords much more. Upload a government ID and one proof of ownership (title document, utility bill in your name, or tenancy head-lease). Documents are private: only you and our review team can see them.'),
      h('button', { class: 'btn btn-primary', onclick: verifyDialog }, icon('shield', 16), 'Start verification'));
  }

  function verifyDialog() {
    modal('Verify your identity and ownership', (body, close) => {
      const docs = {}; const err = h('div', { class: 'form-error', hidden: true });
      const idType = h('select', null, ID_TYPES.map(([v, l]) => h('option', { value: v }, l)));
      const note = h('textarea', { maxlength: 500, style: { minHeight: '70px' }, placeholder: 'e.g. Deed of assignment for 12 Herbert Macaulay Way, in my name' });
      const slot = (key, label, required) => {
        const status = h('div', { class: 'small muted' }, required ? 'Required' : 'Optional');
        const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', onchange: async (e) => {
          const f = e.target.files[0]; if (!f) return;
          status.textContent = 'Uploading…';
          try { const small = f.type.startsWith('image/') ? await shrinkImage(f, 2200, 0.85) : f; const r = await upload('doc', small); docs[key] = r.path; status.textContent = `Uploaded: ${f.name}`; status.style.color = 'var(--moss)'; }
          catch (er) { status.textContent = er.message; status.style.color = 'var(--brick)'; }
        } });
        return field(label, h('div', null, input, status));
      };
      body.append(err, field('ID type', idType), slot('id_doc', 'Photo of your ID (clear, all four corners visible)', true),
        slot('selfie_doc', 'Selfie holding your ID', false), slot('ownership_doc', 'Proof of ownership or authority to let', true), field('Note for the reviewer', note),
        h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', { class: 'btn btn-primary', onclick: async () => {
            try { await post('/api/verification', { id_type: idType.value, id_doc: docs.id_doc, selfie_doc: docs.selfie_doc, ownership_doc: docs.ownership_doc, ownership_note: note.value }); close(); toast('Submitted. We will review it shortly.', 'success'); await refreshSession(); draw(); }
            catch (e) { err.textContent = e.message; err.hidden = false; }
          } }, 'Submit for review')));
    });
  }

  await draw();
}
