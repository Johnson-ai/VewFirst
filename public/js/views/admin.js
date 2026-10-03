import { h, clear, state, get, post, icon, toast, fail, modal, confirmDialog, field, dateOnly, emptyState, cap, timeAgo } from '../lib.js';

export default async function admin(root) {
  if (!state.user || state.user.role !== 'admin') { root.append(h('div', { class: 'wrap page' }, emptyState('Admins only', 'You do not have access to this page.'))); return; }
  let tab = 'verifications';
  const host = h('div', { class: 'wrap page' });
  root.append(host);
  const body = h('div');

  async function draw() {
    const s = await get('/api/admin/stats');
    const stat = (n, l) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, l));
    clear(host).append(h('h1', { style: { fontSize: '2rem' } }, 'Admin'),
      h('div', { class: 'stat-row' }, stat(s.pending_verifications, 'verifications waiting'), stat(s.open_reports, 'open reports'), stat(s.published, 'live listings'), stat(s.verified, 'verified landlords'), stat(s.users, 'users'), stat(s.viewings, 'viewings booked')),
      h('div', { class: 'tabs', role: 'tablist' }, [['verifications', 'Verifications'], ['reports', 'Reports'], ['listings', 'Listings'], ['users', 'Users']].map(([k, l]) => h('button', { class: tab === k ? 'on' : '', role: 'tab', onclick: () => { tab = k; draw(); } }, l))), body);
    clear(body);
    await ({ verifications, reports, listings, users }[tab])();
  }

  async function verifications() {
    const { items } = await get('/api/admin/verifications');
    if (!items.length) return body.append(emptyState('Nothing to review', 'New landlord verification requests will appear here.'));
    items.forEach((v) => {
      const doc = (file, label) => h('a', { href: `/api/private/${file}`, target: '_blank', rel: 'noopener' }, label);
      const thumb = (file) => /\.pdf$/.test(file) ? h('span', { class: 'chip' }, 'PDF') : h('img', { class: 'doc-thumb', src: `/api/private/${file}`, alt: '' });
      body.append(h('article', { class: 'panel', style: { marginBottom: '1rem' } },
        h('div', { class: 'row between wrap-row gap' }, h('div', null, h('strong', null, v.name), h('div', { class: 'small muted' }, `${v.email}${v.phone ? ' · ' + v.phone : ''} · submitted ${timeAgo(v.created_at)}`)), h('span', { class: 'chip chip-warn' }, 'Pending')),
        h('p', { class: 'small' }, h('strong', null, 'ID type: '), v.id_type.replace('_', ' '), v.ownership_note ? [h('br'), h('strong', null, 'Their note: '), v.ownership_note] : null),
        h('div', { class: 'row wrap-row gap' }, h('div', null, thumb(v.id_doc), h('div', { class: 'doc-links' }, doc(v.id_doc, 'Open ID'))),
          v.selfie_doc ? h('div', null, thumb(v.selfie_doc), h('div', { class: 'doc-links' }, doc(v.selfie_doc, 'Open selfie'))) : null,
          h('div', null, thumb(v.ownership_doc), h('div', { class: 'doc-links' }, doc(v.ownership_doc, 'Open ownership proof')))),
        h('div', { class: 'row gap', style: { marginTop: '1rem' } },
          h('button', { class: 'btn btn-primary', onclick: async () => { if (await confirmDialog('Approve landlord', `${v.name} will get the verified badge and can publish listings. Make sure the name on the ID matches the ownership proof.`, 'Approve')) decide(v, 'approved'); } }, icon('check', 16), 'Approve'),
          h('button', { class: 'btn', onclick: () => rejectDialog(v) }, 'Request changes'))));
    });
  }
  function rejectDialog(v) {
    modal('What should they fix?', (b, close) => {
      const t = h('textarea', { maxlength: 400, placeholder: 'e.g. The photo of the ID is blurry. Please upload a clearer image.' }); const err = h('div', { class: 'form-error', hidden: true });
      b.append(err, field('Message to the landlord', t), h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn btn-danger', onclick: async () => { try { await post(`/api/admin/verifications/${v.id}/decision`, { decision: 'rejected', reason: t.value }); close(); toast('Sent'); draw(); } catch (e) { err.textContent = e.message; err.hidden = false; } } }, 'Send')));
    });
  }
  async function decide(v, decision) { try { await post(`/api/admin/verifications/${v.id}/decision`, { decision }); toast('Approved', 'success'); draw(); } catch (e) { fail(e); } }

  async function reports() {
    const { items } = await get('/api/admin/reports');
    if (!items.length) return body.append(emptyState('No open reports', 'Reports from tenants and landlords land here.'));
    items.forEach((r) => body.append(h('article', { class: 'panel', style: { marginBottom: '1rem' } },
      h('div', { class: 'row between wrap-row gap' }, h('div', null, h('span', { class: 'chip chip-bad' }, r.reason.replace('_', ' ')), ' ', h('strong', null, cap(r.target_type), ' #', r.target_id)), h('span', { class: 'small muted' }, `by ${r.reporter_name} · ${timeAgo(r.created_at)}`)),
      h('p', { style: { margin: '.6rem 0', whiteSpace: 'pre-wrap' } }, r.preview),
      r.details ? h('p', { class: 'small muted' }, `Reporter says: ${r.details}`) : null,
      h('div', { class: 'row gap-s wrap-row' },
        r.target_type === 'listing' ? h('a', { class: 'btn btn-sm', href: `#/listing/${r.target_id}` }, 'Open listing') : null,
        r.target_type !== 'user' ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => resolve(r, 'remove_content') }, r.target_type === 'listing' ? 'Remove listing' : 'Hide content') : null,
        h('button', { class: 'btn btn-sm', onclick: async () => { if (await confirmDialog('Suspend the account?', 'They are logged out immediately and their live listings are archived.', 'Suspend', true)) resolve(r, 'suspend_user'); } }, 'Suspend user'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => resolve(r, 'dismiss') }, 'Dismiss')))));
  }
  async function resolve(r, action) { try { await post(`/api/admin/reports/${r.id}/resolve`, { action }); toast('Done', 'success'); draw(); } catch (e) { fail(e); } }

  async function listings() {
    const q = h('input', { type: 'search', placeholder: 'Search title or owner', style: { maxWidth: '320px' } });
    const out = h('div');
    const load = async () => {
      const { items } = await get(`/api/admin/listings?q=${encodeURIComponent(q.value)}`);
      clear(out).append(h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Listing', 'Owner', 'Status', ''].map((t) => h('th', null, t)))),
        h('tbody', null, items.map((l) => h('tr', null, h('td', null, h('a', { href: `#/listing/${l.id}` }, l.title), h('div', { class: 'small muted' }, `${l.area}, ${l.city}`)), h('td', null, l.owner_name), h('td', null, h('span', { class: 'chip' }, l.status)),
          h('td', null, h('div', { class: 'row gap-s' }, l.status !== 'removed' ? h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { await post(`/api/admin/listings/${l.id}/status`, { status: 'removed' }); load(); } }, 'Remove') : h('button', { class: 'btn btn-sm', onclick: async () => { await post(`/api/admin/listings/${l.id}/status`, { status: 'archived' }); load(); } }, 'Restore')))))))));
    };
    q.addEventListener('input', () => { clearTimeout(q._t); q._t = setTimeout(load, 250); });
    body.append(h('div', { style: { marginBottom: '1rem' } }, q), out); await load();
  }

  async function users() {
    const q = h('input', { type: 'search', placeholder: 'Search name or email', style: { maxWidth: '320px' } });
    const out = h('div');
    const load = async () => {
      const { items } = await get(`/api/admin/users?q=${encodeURIComponent(q.value)}`);
      clear(out).append(h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['User', 'Role', 'Verification', 'Joined', ''].map((t) => h('th', null, t)))),
        h('tbody', null, items.map((u) => h('tr', null, h('td', null, h('strong', null, u.name), h('div', { class: 'small muted' }, u.email)), h('td', null, u.role), h('td', null, u.verified_status), h('td', null, dateOnly(u.created_at)),
          h('td', null, u.role === 'admin' ? null : h('button', { class: `btn btn-sm ${u.suspended ? '' : 'btn-danger'}`, onclick: async () => { try { await post(`/api/admin/users/${u.id}/suspend`, { suspended: !u.suspended }); load(); } catch (e) { fail(e); } } }, u.suspended ? 'Reinstate' : 'Suspend'))))))));
    };
    q.addEventListener('input', () => { clearTimeout(q._t); q._t = setTimeout(load, 250); });
    body.append(h('div', { style: { marginBottom: '1rem' } }, q), out); await load();
  }

  await draw();
}
