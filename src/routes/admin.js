'use strict';
const { q, tx, notify } = require('../db');
const { bad, notFound, forbidden, str, int, oneOf } = require('../http');
const { requireAuth, requireRole } = require('../auth');
const { privateFileExists } = require('./uploads');

const ID_TYPES = ['national_id', 'passport', 'drivers_license', 'voters_card', 'other'];

module.exports = (r) => {
  // ============================================================ landlord side
  r.get('/api/verification', requireRole('landlord'), (ctx) => ({
    status: ctx.user.verified_status,
    latest: q.get('SELECT id,id_type,status,reason,created_at,reviewed_at FROM verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', ctx.user.id) || null,
  }));

  r.post('/api/verification', requireRole('landlord'), (ctx) => {
    if (ctx.user.verified_status === 'verified') throw bad('You are already verified.');
    if (ctx.user.verified_status === 'pending') throw bad('Your documents are already being reviewed.');
    const b = ctx.body;
    const idType = oneOf(b.id_type, ID_TYPES, 'ID type');
    for (const key of ['id_doc', 'ownership_doc']) {
      if (!privateFileExists(b[key])) throw bad('A required document could not be found. Please upload it again.');
    }
    if (b.selfie_doc && !privateFileExists(b.selfie_doc)) throw bad('The selfie could not be found. Please upload it again.');
    const note = str(b.ownership_note, { max: 500, field: 'Note' });
    tx(() => {
      q.run('INSERT INTO verifications (user_id,id_type,id_doc,selfie_doc,ownership_doc,ownership_note) VALUES (?,?,?,?,?,?)',
        ctx.user.id, idType, b.id_doc, b.selfie_doc || null, b.ownership_doc, note || null);
      q.run("UPDATE users SET verified_status = 'pending' WHERE id = ?", ctx.user.id);
    });
    for (const a of q.all("SELECT id FROM users WHERE role = 'admin'")) notify(a.id, 'admin', 'New verification to review', ctx.user.name, '#/admin');
    ctx.status = 201;
    return { ok: true };
  });

  // ============================================================ admin
  const admin = requireRole('admin');

  r.get('/api/admin/stats', admin, () => ({
    users: q.get("SELECT COUNT(*) c FROM users WHERE role != 'admin'").c,
    landlords: q.get("SELECT COUNT(*) c FROM users WHERE role = 'landlord'").c,
    verified: q.get("SELECT COUNT(*) c FROM users WHERE verified_status = 'verified' AND role = 'landlord'").c,
    pending_verifications: q.get("SELECT COUNT(*) c FROM verifications WHERE status = 'pending'").c,
    published: q.get("SELECT COUNT(*) c FROM listings WHERE status = 'published'").c,
    open_reports: q.get("SELECT COUNT(*) c FROM reports WHERE status = 'open'").c,
    viewings: q.get('SELECT COUNT(*) c FROM viewings').c,
    messages: q.get('SELECT COUNT(*) c FROM messages').c,
  }));

  r.get('/api/admin/verifications', admin, (ctx) => {
    const status = ctx.query.get('status') || 'pending';
    const rows = q.all(
      `SELECT v.*, u.name, u.email, u.phone FROM verifications v JOIN users u ON u.id = v.user_id
       WHERE v.status = ? ORDER BY v.id ASC LIMIT 100`, status);
    return { items: rows.map((v) => ({ ...v, id_doc: v.id_doc.slice(8), selfie_doc: v.selfie_doc ? v.selfie_doc.slice(8) : null, ownership_doc: v.ownership_doc.slice(8) })) };
  });

  r.post('/api/admin/verifications/:id/decision', admin, (ctx) => {
    const v = q.get('SELECT * FROM verifications WHERE id = ?', ctx.params.id);
    if (!v) throw notFound();
    if (v.status !== 'pending') throw bad('This request was already reviewed.');
    const decision = oneOf(ctx.body.decision, ['approved', 'rejected'], 'Decision');
    const reason = str(ctx.body.reason, { max: 400, field: 'Reason' });
    if (decision === 'rejected' && reason.length < 5) throw bad('Tell the landlord what to fix so they can resubmit.');
    tx(() => {
      q.run("UPDATE verifications SET status=?, reason=?, reviewer_id=?, reviewed_at=datetime('now') WHERE id=?", decision, reason || null, ctx.user.id, v.id);
      q.run(`UPDATE users SET verified_status = ?, verified_at = ${decision === 'approved' ? "datetime('now')" : 'NULL'} WHERE id = ?`, decision === 'approved' ? 'verified' : 'rejected', v.user_id);
    });
    notify(v.user_id, 'verification', decision === 'approved' ? 'You are now a verified landlord' : 'Verification needs changes',
      decision === 'approved' ? 'You can publish listings and your profile shows the verified badge.' : reason, '#/dashboard');
    return { ok: true };
  });

  r.get('/api/admin/reports', admin, (ctx) => {
    const status = ctx.query.get('status') || 'open';
    const rows = q.all(
      `SELECT rp.*, u.name AS reporter_name FROM reports rp JOIN users u ON u.id = rp.reporter_id WHERE rp.status = ? ORDER BY rp.id ASC LIMIT 100`, status);
    const items = rows.map((rp) => {
      let preview = '';
      if (rp.target_type === 'listing') preview = q.get('SELECT title FROM listings WHERE id = ?', rp.target_id)?.title;
      if (rp.target_type === 'comment') preview = q.get('SELECT body FROM comments WHERE id = ?', rp.target_id)?.body;
      if (rp.target_type === 'review') preview = q.get('SELECT body FROM reviews WHERE id = ?', rp.target_id)?.body;
      if (rp.target_type === 'user') preview = q.get('SELECT name FROM users WHERE id = ?', rp.target_id)?.name;
      return { ...rp, preview: preview || '(deleted)' };
    });
    return { items };
  });

  r.post('/api/admin/reports/:id/resolve', admin, (ctx) => {
    const rp = q.get('SELECT * FROM reports WHERE id = ?', ctx.params.id);
    if (!rp) throw notFound();
    const action = oneOf(ctx.body.action, ['dismiss', 'remove_content', 'suspend_user'], 'Action');
    tx(() => {
      if (action === 'remove_content') {
        if (rp.target_type === 'listing') q.run("UPDATE listings SET status = 'removed' WHERE id = ?", rp.target_id);
        if (rp.target_type === 'comment') q.run('UPDATE comments SET hidden = 1 WHERE id = ?', rp.target_id);
        if (rp.target_type === 'review') q.run('UPDATE reviews SET hidden = 1 WHERE id = ?', rp.target_id);
        if (rp.target_type === 'user') throw bad('Use "Suspend user" for accounts.');
      }
      if (action === 'suspend_user') {
        let uid = null;
        if (rp.target_type === 'user') uid = rp.target_id;
        if (rp.target_type === 'listing') uid = q.get('SELECT owner_id FROM listings WHERE id = ?', rp.target_id)?.owner_id;
        if (rp.target_type === 'comment') uid = q.get('SELECT author_id FROM comments WHERE id = ?', rp.target_id)?.author_id;
        if (rp.target_type === 'review') uid = q.get('SELECT author_id FROM reviews WHERE id = ?', rp.target_id)?.author_id;
        const target = uid && q.get('SELECT role FROM users WHERE id = ?', uid);
        if (!target) throw bad('That account no longer exists.');
        if (target.role === 'admin') throw forbidden('Admins cannot be suspended here.');
        q.run('UPDATE users SET suspended = 1 WHERE id = ?', uid);
        q.run('DELETE FROM sessions WHERE user_id = ?', uid);
        q.run("UPDATE listings SET status = 'archived' WHERE owner_id = ? AND status = 'published'", uid);
      }
      q.run("UPDATE reports SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", action === 'dismiss' ? 'dismissed' : 'actioned', ctx.user.id, rp.id);
    });
    return { ok: true };
  });

  r.get('/api/admin/users', admin, (ctx) => {
    const text = `%${(ctx.query.get('q') || '').trim().slice(0, 60)}%`;
    return {
      items: q.all(
        `SELECT id,name,email,role,verified_status,suspended,created_at FROM users WHERE (name LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 100`, text, text),
    };
  });

  r.post('/api/admin/users/:id/suspend', admin, (ctx) => {
    const u = q.get('SELECT * FROM users WHERE id = ?', ctx.params.id);
    if (!u) throw notFound();
    if (u.role === 'admin') throw forbidden('Admins cannot be suspended here.');
    const suspended = ctx.body.suspended ? 1 : 0;
    q.run('UPDATE users SET suspended = ? WHERE id = ?', suspended, u.id);
    if (suspended) {
      q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      q.run("UPDATE listings SET status = 'archived' WHERE owner_id = ? AND status = 'published'", u.id);
    }
    return { suspended: !!suspended };
  });

  r.get('/api/admin/listings', admin, (ctx) => {
    const text = `%${(ctx.query.get('q') || '').trim().slice(0, 60)}%`;
    return {
      items: q.all(
        `SELECT l.id,l.title,l.status,l.city,l.area,l.created_at,u.name AS owner_name FROM listings l JOIN users u ON u.id = l.owner_id
         WHERE l.title LIKE ? OR u.name LIKE ? ORDER BY l.id DESC LIMIT 100`, text, text),
    };
  });

  r.post('/api/admin/listings/:id/status', admin, (ctx) => {
    const status = oneOf(ctx.body.status, ['published', 'archived', 'removed'], 'Status');
    const info = q.run('UPDATE listings SET status = ? WHERE id = ?', status, ctx.params.id);
    if (!info.changes) throw notFound();
    return { status };
  });
};
