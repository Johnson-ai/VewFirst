'use strict';
const { q, tx, notify } = require('../db');
const { bad, forbidden, notFound, str, int, oneOf, rateLimit } = require('../http');
const { requireAuth, requireRole } = require('../auth');

function getListingForOwner(ctx) {
  const l = q.get('SELECT * FROM listings WHERE id = ?', ctx.params.id);
  if (!l) throw notFound('Listing not found.');
  if (l.owner_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
  return l;
}

function tourComplete(userId, listingId) {
  const rooms = q.all('SELECT id FROM rooms WHERE listing_id = ?', listingId).map((x) => x.id);
  const need = rooms.length ? rooms : [0];
  const seen = q.all('SELECT room_id FROM tour_progress WHERE user_id = ? AND listing_id = ?', userId, listingId).map((x) => x.room_id);
  return need.every((id) => seen.includes(id));
}

const viewingSelect = `
  SELECT v.*, l.title AS listing_title, l.area, l.city,
         t.name AS tenant_name, t.phone AS tenant_phone, o.name AS landlord_name, o.phone AS landlord_phone
  FROM viewings v JOIN listings l ON l.id = v.listing_id
  JOIN users t ON t.id = v.tenant_id JOIN users o ON o.id = v.landlord_id`;

function shape(v, user) {
  const confirmed = ['confirmed', 'completed'].includes(v.status);
  const out = {
    id: v.id, listing_id: v.listing_id, listing_title: v.listing_title, area: v.area, city: v.city,
    starts_at: v.starts_at, duration_min: v.duration_min, status: v.status, note: v.note, created_at: v.created_at,
    tenant: { id: v.tenant_id, name: v.tenant_name }, landlord: { id: v.landlord_id, name: v.landlord_name },
    role: user.id === v.landlord_id ? 'landlord' : 'tenant',
  };
  // Phone numbers are shared only once the viewing is confirmed.
  if (confirmed) { out.tenant.phone = v.tenant_phone; out.landlord.phone = v.landlord_phone; }
  if (confirmed && user.id === v.tenant_id) {
    out.address = q.get('SELECT address FROM listings WHERE id = ?', v.listing_id).address;
  }
  return out;
}

module.exports = (r) => {
  // Open slots for a listing (public).
  r.get('/api/listings/:id/slots', (ctx) => {
    const now = new Date().toISOString();
    const slots = q.all(
      "SELECT id, starts_at, duration_min, status FROM viewing_slots WHERE listing_id = ? AND starts_at > ? ORDER BY starts_at LIMIT 60", ctx.params.id, now);
    const isOwner = ctx.user && q.get('SELECT 1 FROM listings WHERE id = ? AND owner_id = ?', ctx.params.id, ctx.user.id);
    return { slots: isOwner ? slots : slots.filter((s) => s.status === 'open') };
  });

  // Landlord adds slots (array of ISO datetimes).
  r.post('/api/listings/:id/slots', requireRole('landlord', 'admin'), (ctx) => {
    const l = getListingForOwner(ctx);
    const times = Array.isArray(ctx.body.times) ? ctx.body.times.slice(0, 40) : [];
    if (!times.length) throw bad('Pick at least one date and time.');
    const duration = int(ctx.body.duration_min ?? 30, { min: 10, max: 240, field: 'Duration' });
    let added = 0;
    for (const t of times) {
      const d = new Date(t);
      if (Number.isNaN(d.getTime())) throw bad('One of the times is not valid.');
      if (d.getTime() < Date.now() + 30 * 60_000) throw bad('Slots must be at least 30 minutes from now.');
      const info = q.run('INSERT OR IGNORE INTO viewing_slots (listing_id,starts_at,duration_min) VALUES (?,?,?)', l.id, d.toISOString(), duration);
      added += Number(info.changes);
    }
    ctx.status = 201;
    return { added };
  });

  r.delete('/api/slots/:id', requireRole('landlord', 'admin'), (ctx) => {
    const s = q.get('SELECT s.*, l.owner_id FROM viewing_slots s JOIN listings l ON l.id = s.listing_id WHERE s.id = ?', ctx.params.id);
    if (!s) throw notFound();
    if (s.owner_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
    if (s.status !== 'open') throw bad('This slot already has a viewing request. Decline or cancel the viewing first.');
    q.run('DELETE FROM viewing_slots WHERE id = ?', s.id);
    return { ok: true };
  });

  // Tenant requests a viewing: only after finishing the virtual tour.
  r.post('/api/listings/:id/viewings', requireAuth, (ctx) => {
    rateLimit(`book:${ctx.user.id}`, 20, 60 * 60_000);
    const l = q.get("SELECT * FROM listings WHERE id = ? AND status = 'published'", ctx.params.id);
    if (!l) throw notFound('This listing is not open for viewings.');
    if (l.owner_id === ctx.user.id) throw bad('You cannot book a viewing on your own listing.');
    if (!tourComplete(ctx.user.id, l.id)) {
      throw bad('Finish the virtual tour first. View every room (or the video) before booking a physical visit.', { code: 'TOUR_INCOMPLETE' });
    }
    if (q.get("SELECT 1 FROM viewings WHERE listing_id = ? AND tenant_id = ? AND status IN ('requested','confirmed')", l.id, ctx.user.id)) {
      throw bad('You already have an active viewing request for this place.');
    }
    const slotId = int(ctx.body.slot_id, { min: 1, field: 'Time slot' });
    const note = str(ctx.body.note, { max: 400, field: 'Note' });
    const id = tx(() => {
      const slot = q.get("SELECT * FROM viewing_slots WHERE id = ? AND listing_id = ? AND status = 'open'", slotId, l.id);
      if (!slot) throw bad('That time slot is no longer available. Pick another.');
      if (new Date(slot.starts_at).getTime() < Date.now()) throw bad('That slot is in the past.');
      q.run("UPDATE viewing_slots SET status = 'held' WHERE id = ?", slot.id);
      const info = q.run(
        'INSERT INTO viewings (listing_id,slot_id,tenant_id,landlord_id,starts_at,duration_min,note) VALUES (?,?,?,?,?,?,?)',
        l.id, slot.id, ctx.user.id, l.owner_id, slot.starts_at, slot.duration_min, note || null);
      return Number(info.lastInsertRowid);
    });
    notify(l.owner_id, 'viewing', 'New viewing request', `${ctx.user.name} wants to view "${l.title}".`, '#/viewings');
    ctx.status = 201;
    return { id };
  });

  r.get('/api/viewings', requireAuth, (ctx) => {
    const rows = q.all(`${viewingSelect} WHERE v.tenant_id = ? OR v.landlord_id = ? ORDER BY v.starts_at DESC LIMIT 100`, ctx.user.id, ctx.user.id);
    return { items: rows.map((v) => shape(v, ctx.user)) };
  });

  r.post('/api/viewings/:id/status', requireAuth, (ctx) => {
    const v = q.get('SELECT * FROM viewings WHERE id = ?', ctx.params.id);
    if (!v) throw notFound();
    const status = oneOf(ctx.body.status, ['confirmed', 'declined', 'cancelled', 'completed'], 'Status');
    const isLandlord = v.landlord_id === ctx.user.id;
    const isTenant = v.tenant_id === ctx.user.id;
    if (!isLandlord && !isTenant && ctx.user.role !== 'admin') throw forbidden();
    const listing = q.get('SELECT title FROM listings WHERE id = ?', v.listing_id);

    const allowed = {
      confirmed: isLandlord && v.status === 'requested',
      declined: isLandlord && v.status === 'requested',
      cancelled: (isLandlord || isTenant) && ['requested', 'confirmed'].includes(v.status),
      completed: isLandlord && v.status === 'confirmed' && new Date(v.starts_at).getTime() < Date.now(),
    };
    if (!allowed[status]) throw bad('That change is not possible for this viewing right now.');

    tx(() => {
      q.run('UPDATE viewings SET status = ? WHERE id = ?', status, v.id);
      if (v.slot_id) {
        if (status === 'confirmed') q.run("UPDATE viewing_slots SET status = 'booked' WHERE id = ?", v.slot_id);
        if (status === 'declined' || status === 'cancelled') q.run("UPDATE viewing_slots SET status = 'open' WHERE id = ?", v.slot_id);
      }
    });
    const other = isLandlord ? v.tenant_id : v.landlord_id;
    const verbs = { confirmed: 'confirmed', declined: 'declined', cancelled: 'cancelled', completed: 'marked as completed' };
    notify(other, 'viewing', `Viewing ${verbs[status]}`, `"${listing.title}" on ${new Date(v.starts_at).toUTCString()}`,
      status === 'confirmed' ? `#/listing/${v.listing_id}` : '#/viewings');
    return { status };
  });

  // Calendar file for confirmed viewings.
  r.get('/api/viewings/:id/ics', requireAuth, (ctx) => {
    const v = q.get(`${viewingSelect} WHERE v.id = ?`, ctx.params.id);
    if (!v) throw notFound();
    if (v.tenant_id !== ctx.user.id && v.landlord_id !== ctx.user.id) throw forbidden();
    if (!['confirmed', 'completed'].includes(v.status)) throw bad('Only confirmed viewings can be added to a calendar.');
    const fmt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const start = new Date(v.starts_at);
    const end = new Date(start.getTime() + v.duration_min * 60_000);
    const address = v.tenant_id === ctx.user.id ? q.get('SELECT address FROM listings WHERE id = ?', v.listing_id).address : `${v.area}, ${v.city}`;
    const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ViewFirst//EN', 'BEGIN:VEVENT', `UID:viewing-${v.id}@viewfirst`,
      `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${esc('Viewing: ' + v.listing_title)}`,
      `LOCATION:${esc(address)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    ctx.raw = { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="viewing-${v.id}.ics"` }, body: Buffer.from(ics) };
  });
};

module.exports.tourComplete = tourComplete;
