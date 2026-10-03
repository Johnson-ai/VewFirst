'use strict';
const { q, notify } = require('../db');
const { bad, forbidden, notFound, str, int, oneOf, rateLimit } = require('../http');
const { requireAuth } = require('../auth');

const visibleListing = (id) => q.get("SELECT * FROM listings WHERE id = ? AND status IN ('published','rented')", id);

module.exports = (r) => {
  // ============================================================ reviews
  r.get('/api/listings/:id/reviews', (ctx) => {
    const l = q.get('SELECT id, owner_id FROM listings WHERE id = ?', ctx.params.id);
    if (!l) throw notFound();
    const items = q.all(
      `SELECT r.id, r.rating_property, r.rating_landlord, r.body, r.verified_visit, r.reply, r.replied_at, r.created_at,
              u.id AS author_id, u.name AS author_name, u.avatar AS author_avatar
       FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.listing_id = ? AND r.hidden = 0 ORDER BY r.id DESC`, l.id);
    const dist = [0, 0, 0, 0, 0];
    for (const it of items) if (it.rating_property) dist[it.rating_property - 1]++;
    let mine = null;
    let canReview = false;
    let reason = null;
    if (ctx.user) {
      mine = items.find((i) => i.author_id === ctx.user.id) || null;
      if (ctx.user.id === l.owner_id) reason = 'You cannot review your own listing.';
      else if (mine) reason = 'You have already reviewed this place. You can edit your review.';
      else canReview = true;
    } else reason = 'Log in to leave a review.';
    return { items, distribution: dist, can_review: canReview || !!mine, reason: canReview || mine ? null : reason };
  });

  // Create or update (one review per person per listing).
  r.post('/api/listings/:id/reviews', requireAuth, (ctx) => {
    rateLimit(`review:${ctx.user.id}`, 20, 60 * 60_000);
    const l = visibleListing(ctx.params.id);
    if (!l) throw notFound('Listing not found.');
    if (l.owner_id === ctx.user.id) throw forbidden('You cannot review your own listing.');
    const rp = ctx.body.rating_property == null || ctx.body.rating_property === '' ? null : int(ctx.body.rating_property, { min: 1, max: 5, field: 'Property rating' });
    const rl = ctx.body.rating_landlord == null || ctx.body.rating_landlord === '' ? null : int(ctx.body.rating_landlord, { min: 1, max: 5, field: 'Landlord rating' });
    if (rp == null && rl == null) throw bad('Rate the property, the landlord, or both.');
    const body = str(ctx.body.body, { min: 10, max: 2000, field: 'Review' });
    // "Verified visit": the tenant had a confirmed/completed viewing booked through the platform.
    const visited = q.get("SELECT 1 FROM viewings WHERE listing_id = ? AND tenant_id = ? AND status IN ('confirmed','completed')", l.id, ctx.user.id) ? 1 : 0;
    const existing = q.get('SELECT id FROM reviews WHERE listing_id = ? AND author_id = ?', l.id, ctx.user.id);
    if (existing) {
      q.run('UPDATE reviews SET rating_property=?, rating_landlord=?, body=?, verified_visit=? WHERE id=?', rp, rl, body, visited, existing.id);
      return { id: existing.id, updated: true };
    }
    const info = q.run('INSERT INTO reviews (listing_id,author_id,rating_property,rating_landlord,body,verified_visit) VALUES (?,?,?,?,?,?)', l.id, ctx.user.id, rp, rl, body, visited);
    notify(l.owner_id, 'review', 'New review', `${ctx.user.name} reviewed "${l.title}".`, `#/listing/${l.id}`);
    ctx.status = 201;
    return { id: Number(info.lastInsertRowid) };
  });

  r.post('/api/reviews/:id/reply', requireAuth, (ctx) => {
    const rv = q.get('SELECT r.*, l.owner_id, l.title FROM reviews r JOIN listings l ON l.id = r.listing_id WHERE r.id = ?', ctx.params.id);
    if (!rv) throw notFound();
    if (rv.owner_id !== ctx.user.id) throw forbidden('Only the landlord can reply to this review.');
    const reply = str(ctx.body.reply, { min: 2, max: 1000, field: 'Reply' });
    q.run("UPDATE reviews SET reply = ?, replied_at = datetime('now') WHERE id = ?", reply, rv.id);
    notify(rv.author_id, 'review', 'The landlord replied to your review', rv.title, `#/listing/${rv.listing_id}`);
    return { ok: true };
  });

  r.delete('/api/reviews/:id', requireAuth, (ctx) => {
    const rv = q.get('SELECT * FROM reviews WHERE id = ?', ctx.params.id);
    if (!rv) throw notFound();
    if (rv.author_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
    q.run('DELETE FROM reviews WHERE id = ?', rv.id);
    return { ok: true };
  });

  // ============================================================ comments (public Q&A under each listing)
  r.get('/api/listings/:id/comments', (ctx) => {
    const l = q.get('SELECT id, owner_id FROM listings WHERE id = ?', ctx.params.id);
    if (!l) throw notFound();
    const rows = q.all(
      `SELECT c.id, c.parent_id, c.body, c.created_at, u.id AS author_id, u.name AS author_name, u.avatar AS author_avatar,
              (u.verified_status = 'verified' AND u.role = 'landlord') AS author_verified
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.listing_id = ? AND c.hidden = 0 ORDER BY c.id ASC`, l.id);
    const items = rows.map((c) => ({ ...c, author_verified: !!c.author_verified, is_landlord: c.author_id === l.owner_id }));
    return { items };
  });

  r.post('/api/listings/:id/comments', requireAuth, (ctx) => {
    rateLimit(`comment:${ctx.user.id}`, 30, 10 * 60_000);
    const l = visibleListing(ctx.params.id);
    if (!l) throw notFound('Listing not found.');
    const body = str(ctx.body.body, { min: 2, max: 1000, field: 'Comment' });
    let parent = null;
    if (ctx.body.parent_id) {
      parent = q.get('SELECT * FROM comments WHERE id = ? AND listing_id = ? AND hidden = 0', int(ctx.body.parent_id, { min: 1 }), l.id);
      if (!parent) throw bad('The comment you are replying to no longer exists.');
      if (parent.parent_id) parent = q.get('SELECT * FROM comments WHERE id = ?', parent.parent_id); // keep threads one level deep
    }
    const info = q.run('INSERT INTO comments (listing_id,author_id,parent_id,body) VALUES (?,?,?,?)', l.id, ctx.user.id, parent ? parent.id : null, body);
    if (parent && parent.author_id !== ctx.user.id) notify(parent.author_id, 'comment', 'New reply to your comment', body.slice(0, 120), `#/listing/${l.id}`);
    if (!parent && l.owner_id !== ctx.user.id) notify(l.owner_id, 'comment', `New question on "${l.title}"`, body.slice(0, 120), `#/listing/${l.id}`);
    ctx.status = 201;
    return { id: Number(info.lastInsertRowid) };
  });

  r.delete('/api/comments/:id', requireAuth, (ctx) => {
    const c = q.get('SELECT c.*, l.owner_id FROM comments c JOIN listings l ON l.id = c.listing_id WHERE c.id = ?', ctx.params.id);
    if (!c) throw notFound();
    if (c.author_id !== ctx.user.id && c.owner_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
    q.run('DELETE FROM comments WHERE id = ?', c.id);
    return { ok: true };
  });

  // ============================================================ messaging
  const convSelect = `
    SELECT c.*, l.title AS listing_title, l.status AS listing_status,
           (SELECT path FROM photos p WHERE p.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover,
           t.name AS tenant_name, t.avatar AS tenant_avatar, o.name AS landlord_name, o.avatar AS landlord_avatar,
           (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.read_at IS NULL) AS unread
    FROM conversations c JOIN listings l ON l.id = c.listing_id
    JOIN users t ON t.id = c.tenant_id JOIN users o ON o.id = c.landlord_id`;

  const convShape = (c, me) => {
    const other = me === c.tenant_id ? { id: c.landlord_id, name: c.landlord_name, avatar: c.landlord_avatar } : { id: c.tenant_id, name: c.tenant_name, avatar: c.tenant_avatar };
    return { id: c.id, listing_id: c.listing_id, listing_title: c.listing_title, cover: c.cover, other, last_body: c.last_body, last_message_at: c.last_message_at, unread: c.unread };
  };

  r.get('/api/conversations', requireAuth, (ctx) => {
    const rows = q.all(`${convSelect} WHERE c.tenant_id = ? OR c.landlord_id = ? ORDER BY c.last_message_at DESC`, ctx.user.id, ctx.user.id, ctx.user.id);
    return { items: rows.map((c) => convShape(c, ctx.user.id)) };
  });

  // Start (or continue) a conversation about a listing. The tenant always initiates.
  r.post('/api/conversations', requireAuth, (ctx) => {
    rateLimit(`msg:${ctx.user.id}`, 60, 10 * 60_000);
    const l = visibleListing(ctx.body.listing_id);
    if (!l) throw notFound('Listing not found.');
    if (l.owner_id === ctx.user.id) throw bad('You cannot message yourself about your own listing.');
    const body = str(ctx.body.body, { min: 1, max: 2000, field: 'Message' });
    let conv = q.get('SELECT * FROM conversations WHERE listing_id = ? AND tenant_id = ?', l.id, ctx.user.id);
    if (!conv) {
      const info = q.run('INSERT INTO conversations (listing_id,tenant_id,landlord_id) VALUES (?,?,?)', l.id, ctx.user.id, l.owner_id);
      conv = { id: Number(info.lastInsertRowid) };
    }
    q.run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', conv.id, ctx.user.id, body);
    q.run("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?", conv.id);
    notify(l.owner_id, 'message', `New message about "${l.title}"`, body.slice(0, 120), `#/messages/${conv.id}`);
    ctx.status = 201;
    return { id: conv.id };
  });

  const loadConv = (ctx) => {
    const c = q.get(`${convSelect} WHERE c.id = ?`, ctx.user.id, ctx.params.id);
    if (!c) throw notFound('Conversation not found.');
    if (c.tenant_id !== ctx.user.id && c.landlord_id !== ctx.user.id) throw forbidden();
    return c;
  };

  r.get('/api/conversations/:id/messages', requireAuth, (ctx) => {
    const c = loadConv(ctx);
    const after = Number(ctx.query.get('after')) || 0;
    const items = q.all('SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 200', c.id, after);
    q.run("UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL", c.id, ctx.user.id);
    return { conversation: convShape(c, ctx.user.id), items };
  });

  r.post('/api/conversations/:id/messages', requireAuth, (ctx) => {
    rateLimit(`msg:${ctx.user.id}`, 60, 10 * 60_000);
    const c = loadConv(ctx);
    const body = str(ctx.body.body, { min: 1, max: 2000, field: 'Message' });
    const info = q.run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', c.id, ctx.user.id, body);
    q.run("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?", c.id);
    const other = ctx.user.id === c.tenant_id ? c.landlord_id : c.tenant_id;
    // Collapse repeated notifications while the other side has not opened the thread.
    const pending = q.get("SELECT id FROM notifications WHERE user_id = ? AND type = 'message' AND link = ? AND read = 0", other, `#/messages/${c.id}`);
    if (!pending) notify(other, 'message', `New message about "${c.listing_title}"`, body.slice(0, 120), `#/messages/${c.id}`);
    ctx.status = 201;
    return { id: Number(info.lastInsertRowid) };
  });

  // ============================================================ notifications + counters
  r.get('/api/counters', (ctx) => {
    if (!ctx.user) return { messages: 0, notifications: 0, viewings: 0 };
    const uid = ctx.user.id;
    return {
      messages: q.get('SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE (c.tenant_id = ? OR c.landlord_id = ?) AND m.sender_id != ? AND m.read_at IS NULL', uid, uid, uid).c,
      notifications: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0', uid).c,
      viewings: q.get("SELECT COUNT(*) c FROM viewings WHERE landlord_id = ? AND status = 'requested'", uid).c,
    };
  });

  r.get('/api/notifications', requireAuth, (ctx) => ({
    items: q.all('SELECT id,type,title,body,link,read,created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', ctx.user.id),
  }));

  r.post('/api/notifications/read', requireAuth, (ctx) => {
    q.run('UPDATE notifications SET read = 1 WHERE user_id = ?', ctx.user.id);
    return { ok: true };
  });

  // ============================================================ reports
  r.post('/api/reports', requireAuth, (ctx) => {
    rateLimit(`report:${ctx.user.id}`, 10, 60 * 60_000);
    const type = oneOf(ctx.body.target_type, ['listing', 'comment', 'review', 'user'], 'Report type');
    const id = int(ctx.body.target_id, { min: 1, field: 'Target' });
    const table = { listing: 'listings', comment: 'comments', review: 'reviews', user: 'users' }[type];
    if (!q.get(`SELECT 1 FROM ${table} WHERE id = ?`, id)) throw notFound('That item no longer exists.');
    const reason = oneOf(ctx.body.reason, ['scam', 'fake_listing', 'misleading', 'abusive', 'spam', 'other'], 'Reason');
    const details = str(ctx.body.details, { max: 800, field: 'Details' });
    if (q.get("SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'", ctx.user.id, type, id)) {
      throw bad('You already reported this. Moderators will review it.');
    }
    q.run('INSERT INTO reports (reporter_id,target_type,target_id,reason,details) VALUES (?,?,?,?,?)', ctx.user.id, type, id, reason, details || null);
    ctx.status = 201;
    return { ok: true };
  });
};
