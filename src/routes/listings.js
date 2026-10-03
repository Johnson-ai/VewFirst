'use strict';
const cfg = require('../config');
const { q, tx, notify } = require('../db');
const { bad, forbidden, notFound, str, int, num, oneOf, rateLimit } = require('../http');
const { requireAuth, requireRole } = require('../auth');
const { publicFileExists, imageSize } = require('./uploads');
const fs = require('node:fs');
const path = require('node:path');

const RATING_JOIN = `
  LEFT JOIN (SELECT listing_id, ROUND(AVG(rating_property),1) AS avg_property, COUNT(rating_property) AS n_property
             FROM reviews WHERE hidden = 0 GROUP BY listing_id) rp ON rp.listing_id = l.id`;

const OWNER_COLS = `u.name AS owner_name, u.avatar AS owner_avatar, (u.verified_status = 'verified') AS owner_verified,
  u.created_at AS owner_since`;

/** Coordinates are rounded for the public so exact addresses stay private until a viewing is confirmed. */
const fuzz = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

function canSeeExact(user, listing) {
  if (!user) return false;
  if (user.role === 'admin' || user.id === listing.owner_id) return true;
  return !!q.get(
    "SELECT 1 FROM viewings WHERE listing_id = ? AND tenant_id = ? AND status IN ('confirmed','completed')", listing.id, user.id);
}

function cardShape(row) {
  return {
    id: row.id, title: row.title, type: row.type, price: row.price, period: row.period,
    beds: row.beds, baths: row.baths, furnished: !!row.furnished, city: row.city, area: row.area,
    lat: fuzz(row.lat), lng: fuzz(row.lng), status: row.status, cover: row.cover,
    rooms: row.room_count, has_video: !!row.video, avg_property: row.avg_property, n_property: row.n_property || 0,
    owner: { id: row.owner_id, name: row.owner_name, verified: !!row.owner_verified },
    published_at: row.published_at, available_from: row.available_from,
  };
}

const parseAmenities = (s) => { try { return JSON.parse(s); } catch { return []; } };

function loadFull(id) {
  const l = q.get(`SELECT l.*, ${OWNER_COLS}, rp.avg_property, rp.n_property
    FROM listings l JOIN users u ON u.id = l.owner_id ${RATING_JOIN} WHERE l.id = ?`, id);
  if (!l) return null;
  l.rooms = q.all('SELECT id,name,panorama,pano_w,pano_h,position FROM rooms WHERE listing_id = ? ORDER BY position, id', id);
  l.photos = q.all('SELECT id,path,position FROM photos WHERE listing_id = ? ORDER BY position, id', id);
  l.amenities = parseAmenities(l.amenities);
  return l;
}

function landlordRating(ownerId) {
  return q.get(`SELECT ROUND(AVG(r.rating_landlord),1) AS avg, COUNT(r.rating_landlord) AS n
    FROM reviews r JOIN listings l ON l.id = r.listing_id WHERE l.owner_id = ? AND r.hidden = 0`, ownerId);
}

function validateInput(b, existing = {}) {
  const out = {};
  out.title = str(b.title ?? existing.title, { min: 5, max: 120, field: 'Title' });
  out.description = str(b.description ?? existing.description, { max: 5000, field: 'Description' });
  out.type = oneOf(b.type ?? existing.type ?? 'apartment', cfg.listingTypes, 'Property type');
  out.price = int(b.price ?? existing.price, { min: 0, max: 2_000_000_000, field: 'Rent' });
  out.period = oneOf(b.period ?? existing.period ?? 'year', ['month', 'year'], 'Rent period');
  out.deposit = int(b.deposit ?? existing.deposit ?? 0, { min: 0, max: 2_000_000_000, field: 'Deposit', def: 0 });
  out.service_charge = int(b.service_charge ?? existing.service_charge ?? 0, { min: 0, max: 2_000_000_000, field: 'Service charge', def: 0 });
  out.beds = int(b.beds ?? existing.beds ?? 1, { min: 0, max: 30, field: 'Bedrooms' });
  out.baths = int(b.baths ?? existing.baths ?? 1, { min: 0, max: 30, field: 'Bathrooms' });
  out.size_sqm = b.size_sqm === '' || b.size_sqm == null ? null : int(b.size_sqm, { min: 1, max: 100000, field: 'Size' });
  out.furnished = b.furnished ?? existing.furnished ? 1 : 0;
  const am = b.amenities ?? parseAmenities(existing.amenities || '[]');
  if (!Array.isArray(am) || am.length > 40) throw bad('Amenities must be a list.');
  out.amenities = JSON.stringify(am.filter((a) => typeof a === 'string').map((a) => a.slice(0, 40)));
  out.city = str(b.city ?? existing.city, { max: 80, field: 'City' });
  out.area = str(b.area ?? existing.area, { max: 80, field: 'Area / neighbourhood' });
  out.address = str(b.address ?? existing.address, { max: 200, field: 'Address' });
  out.lat = num(b.lat ?? existing.lat, { min: -90, max: 90, field: 'Latitude' });
  out.lng = num(b.lng ?? existing.lng, { min: -180, max: 180, field: 'Longitude' });
  const af = b.available_from ?? existing.available_from ?? null;
  if (af && !/^\d{4}-\d{2}-\d{2}$/.test(af)) throw bad('Available-from date is not valid.');
  out.available_from = af || null;
  out.min_lease_months = int(b.min_lease_months ?? existing.min_lease_months ?? 12, { min: 1, max: 120, field: 'Minimum lease' });
  out.rules = str(b.rules ?? existing.rules, { max: 1500, field: 'House rules' });
  const video = b.video === undefined ? existing.video : b.video;
  if (video && !publicFileExists(video)) throw bad('The video upload could not be found. Please upload it again.');
  out.video = video || null;
  return out;
}

function syncMedia(listingId, b) {
  if (Array.isArray(b.photos)) {
    if (b.photos.length > 30) throw bad('You can add up to 30 photos.');
    for (const p of b.photos) if (!publicFileExists(p)) throw bad('One of the photos could not be found. Please upload it again.');
    q.run('DELETE FROM photos WHERE listing_id = ?', listingId);
    b.photos.forEach((p, i) => q.run('INSERT INTO photos (listing_id,path,position) VALUES (?,?,?)', listingId, p, i));
  }
  if (Array.isArray(b.rooms)) {
    if (b.rooms.length > 25) throw bad('You can add up to 25 rooms.');
    const keep = [];
    b.rooms.forEach((rm, i) => {
      const name = str(rm.name, { min: 1, max: 60, field: 'Room name' });
      if (!publicFileExists(rm.panorama)) throw bad(`The 360° photo for "${name}" could not be found. Please upload it again.`);
      const file = path.join(cfg.uploadDir, path.basename(rm.panorama));
      const buf = fs.readFileSync(file);
      const ext = path.extname(file).slice(1);
      const { width, height } = imageSize(buf, ext);
      const existing = q.get('SELECT id FROM rooms WHERE listing_id = ? AND panorama = ?', listingId, rm.panorama);
      if (existing) {
        q.run('UPDATE rooms SET name=?, position=?, pano_w=?, pano_h=? WHERE id=?', name, i, width, height, existing.id);
        keep.push(existing.id);
      } else {
        const info = q.run('INSERT INTO rooms (listing_id,name,panorama,pano_w,pano_h,position) VALUES (?,?,?,?,?,?)', listingId, name, rm.panorama, width, height, i);
        keep.push(Number(info.lastInsertRowid));
      }
    });
    const all = q.all('SELECT id FROM rooms WHERE listing_id = ?', listingId).map((x) => x.id);
    for (const id of all) if (!keep.includes(id)) q.run('DELETE FROM rooms WHERE id = ?', id);
  }
}

function publishChecks(user, listing) {
  const problems = [];
  if (cfg.requireVerification && user.verified_status !== 'verified') {
    problems.push('Your landlord verification must be approved before you can publish.');
  }
  const photos = q.get('SELECT COUNT(*) c FROM photos WHERE listing_id = ?', listing.id).c;
  const rooms = q.get('SELECT COUNT(*) c FROM rooms WHERE listing_id = ?', listing.id).c;
  if (photos < 1) problems.push('Add at least one photo.');
  if (rooms < 1 && !listing.video) problems.push('Add at least one 360° room or a video walkthrough so tenants can tour before visiting.');
  if (!listing.city || !listing.area) problems.push('Add the city and area.');
  if (listing.price <= 0) problems.push('Set the rent.');
  if (listing.lat == null || listing.lng == null) problems.push('Pin the property on the map.');
  return problems;
}

module.exports = (r) => {
  // ------------------------------------------------------------- search
  r.get('/api/listings', (ctx) => {
    const p = ctx.query;
    const where = ["l.status = 'published'", 'u.suspended = 0'];
    const args = [];
    const text = (p.get('q') || '').trim().slice(0, 80);
    if (text) {
      where.push('(l.title LIKE ? OR l.area LIKE ? OR l.city LIKE ? OR l.description LIKE ?)');
      const like = `%${text.replace(/[%_]/g, '')}%`;
      args.push(like, like, like, like);
    }
    const city = (p.get('city') || '').trim();
    if (city) { where.push('l.city LIKE ?'); args.push(`%${city}%`); }
    const type = p.get('type');
    if (type && cfg.listingTypes.includes(type)) { where.push('l.type = ?'); args.push(type); }
    const minP = Number(p.get('min_price')); if (minP > 0) { where.push('l.price >= ?'); args.push(minP); }
    const maxP = Number(p.get('max_price')); if (maxP > 0) { where.push('l.price <= ?'); args.push(maxP); }
    const beds = Number(p.get('beds')); if (beds > 0) { where.push('l.beds >= ?'); args.push(beds); }
    const baths = Number(p.get('baths')); if (baths > 0) { where.push('l.baths >= ?'); args.push(baths); }
    const period = p.get('period'); if (period === 'month' || period === 'year') { where.push('l.period = ?'); args.push(period); }
    if (p.get('furnished') === '1') where.push('l.furnished = 1');
    if (p.get('verified') === '1') where.push("u.verified_status = 'verified'");
    if (p.get('tour') === '1') where.push('(EXISTS (SELECT 1 FROM rooms rr WHERE rr.listing_id = l.id) OR l.video IS NOT NULL)');
    for (const a of p.getAll('amenity').slice(0, 8)) { where.push('l.amenities LIKE ?'); args.push(`%${JSON.stringify(a).slice(1, -1)}%`); }
    const bbox = (p.get('bbox') || '').split(',').map(Number); // south,west,north,east
    if (bbox.length === 4 && bbox.every(Number.isFinite)) {
      where.push('l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ?');
      args.push(bbox[0], bbox[2], bbox[1], bbox[3]);
    }
    const sorts = {
      newest: 'l.published_at DESC', price_asc: 'l.price ASC', price_desc: 'l.price DESC',
      rating: 'COALESCE(rp.avg_property,0) DESC, rp.n_property DESC',
    };
    const order = sorts[p.get('sort')] || sorts.newest;
    const limit = Math.min(Math.max(Number(p.get('limit')) || 12, 1), 200);
    const page = Math.max(Number(p.get('page')) || 1, 1);
    const base = `FROM listings l JOIN users u ON u.id = l.owner_id ${RATING_JOIN} WHERE ${where.join(' AND ')}`;
    const total = q.get(`SELECT COUNT(*) c ${base}`, ...args).c;
    const rows = q.all(
      `SELECT l.*, ${OWNER_COLS}, rp.avg_property, rp.n_property,
        (SELECT path FROM photos ph WHERE ph.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover,
        (SELECT COUNT(*) FROM rooms rr WHERE rr.listing_id = l.id) AS room_count
       ${base} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    return { total, page, pages: Math.ceil(total / limit), items: rows.map(cardShape) };
  });

  r.get('/api/listings/featured', () => {
    const rows = q.all(
      `SELECT l.*, ${OWNER_COLS}, rp.avg_property, rp.n_property,
        (SELECT path FROM photos ph WHERE ph.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover,
        (SELECT COUNT(*) FROM rooms rr WHERE rr.listing_id = l.id) AS room_count
       FROM listings l JOIN users u ON u.id = l.owner_id ${RATING_JOIN}
       WHERE l.status = 'published' AND u.suspended = 0
       ORDER BY (u.verified_status = 'verified') DESC, l.published_at DESC LIMIT 6`);
    const stats = q.get(`SELECT
      (SELECT COUNT(*) FROM listings WHERE status='published') AS listings,
      (SELECT COUNT(*) FROM users WHERE verified_status='verified' AND role='landlord') AS verified_landlords,
      (SELECT COUNT(*) FROM rooms) AS rooms`);
    return { items: rows.map(cardShape), stats };
  });

  // ------------------------------------------------------------- owner area
  r.get('/api/my/listings', requireRole('landlord', 'admin'), (ctx) => {
    const rows = q.all(
      `SELECT l.*, ${OWNER_COLS}, rp.avg_property, rp.n_property,
        (SELECT path FROM photos ph WHERE ph.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover,
        (SELECT COUNT(*) FROM rooms rr WHERE rr.listing_id = l.id) AS room_count,
        (SELECT COUNT(*) FROM favorites f WHERE f.listing_id = l.id) AS saves,
        (SELECT COUNT(*) FROM conversations c WHERE c.listing_id = l.id) AS inquiries,
        (SELECT COUNT(*) FROM viewings v WHERE v.listing_id = l.id AND v.status = 'requested') AS pending_viewings,
        (SELECT COUNT(DISTINCT tp.user_id) FROM tour_progress tp WHERE tp.listing_id = l.id) AS tour_visitors
       FROM listings l JOIN users u ON u.id = l.owner_id ${RATING_JOIN}
       WHERE l.owner_id = ? AND l.status != 'removed' ORDER BY l.updated_at DESC`, ctx.user.id);
    return {
      items: rows.map((row) => ({ ...cardShape(row), views: row.views, saves: row.saves, inquiries: row.inquiries, pending_viewings: row.pending_viewings, tour_visitors: row.tour_visitors, lat: row.lat, lng: row.lng })),
    };
  });

  r.post('/api/listings', requireRole('landlord', 'admin'), (ctx) => {
    rateLimit(`newlisting:${ctx.user.id}`, 30, 60 * 60_000);
    const data = validateInput(ctx.body);
    const id = tx(() => {
      const info = q.run(
        `INSERT INTO listings (owner_id,title,description,type,price,period,deposit,service_charge,beds,baths,size_sqm,furnished,amenities,city,area,address,lat,lng,available_from,min_lease_months,rules,video)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ctx.user.id, data.title, data.description, data.type, data.price, data.period, data.deposit, data.service_charge,
        data.beds, data.baths, data.size_sqm, data.furnished, data.amenities, data.city, data.area, data.address,
        data.lat, data.lng, data.available_from, data.min_lease_months, data.rules, data.video);
      const newId = Number(info.lastInsertRowid);
      syncMedia(newId, ctx.body);
      return newId;
    });
    ctx.status = 201;
    return { id };
  });

  r.put('/api/listings/:id', requireAuth, (ctx) => {
    const existing = q.get('SELECT * FROM listings WHERE id = ?', ctx.params.id);
    if (!existing) throw notFound('Listing not found.');
    if (existing.owner_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
    if (existing.status === 'removed') throw forbidden('This listing was removed by moderators.');
    const data = validateInput(ctx.body, existing);
    tx(() => {
      q.run(
        `UPDATE listings SET title=?,description=?,type=?,price=?,period=?,deposit=?,service_charge=?,beds=?,baths=?,size_sqm=?,furnished=?,amenities=?,city=?,area=?,address=?,lat=?,lng=?,available_from=?,min_lease_months=?,rules=?,video=?,updated_at=datetime('now') WHERE id=?`,
        data.title, data.description, data.type, data.price, data.period, data.deposit, data.service_charge, data.beds, data.baths,
        data.size_sqm, data.furnished, data.amenities, data.city, data.area, data.address, data.lat, data.lng, data.available_from,
        data.min_lease_months, data.rules, data.video, existing.id);
      syncMedia(existing.id, ctx.body);
      // A published listing must stay publishable.
      if (existing.status === 'published') {
        const fresh = q.get('SELECT * FROM listings WHERE id = ?', existing.id);
        const problems = publishChecks(ctx.user.role === 'admin' ? { verified_status: 'verified' } : ctx.user, fresh);
        if (problems.length) throw bad('This listing is live, so it must keep: ' + problems.join(' '));
      }
    });
    return { id: existing.id };
  });

  r.post('/api/listings/:id/status', requireAuth, (ctx) => {
    const l = q.get('SELECT * FROM listings WHERE id = ?', ctx.params.id);
    if (!l) throw notFound('Listing not found.');
    if (l.owner_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
    if (l.status === 'removed' && ctx.user.role !== 'admin') throw forbidden('This listing was removed by moderators.');
    const status = oneOf(ctx.body.status, ['draft', 'published', 'rented', 'archived'], 'Status');
    if (status === 'published') {
      const owner = q.get('SELECT * FROM users WHERE id = ?', l.owner_id);
      const problems = publishChecks(owner, l);
      if (problems.length) throw bad('Before publishing: ' + problems.join(' '), { problems });
    }
    q.run(`UPDATE listings SET status = ?, updated_at = datetime('now'), published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN datetime('now') ELSE published_at END WHERE id = ?`, status, status, l.id);
    if (status === 'rented') {
      // Let people who saved it know it is gone.
      for (const f of q.all('SELECT user_id FROM favorites WHERE listing_id = ?', l.id)) {
        notify(f.user_id, 'listing', 'A saved place was rented', l.title, `#/listing/${l.id}`);
      }
    }
    return { status };
  });

  r.delete('/api/listings/:id', requireAuth, (ctx) => {
    const l = q.get('SELECT * FROM listings WHERE id = ?', ctx.params.id);
    if (!l) throw notFound('Listing not found.');
    if (l.owner_id !== ctx.user.id && ctx.user.role !== 'admin') throw forbidden();
    q.run('DELETE FROM listings WHERE id = ?', l.id);
    return { ok: true };
  });

  // ------------------------------------------------------------- detail
  r.get('/api/listings/:id', (ctx) => {
    const l = loadFull(ctx.params.id);
    if (!l) throw notFound('Listing not found.');
    const isOwner = ctx.user && (ctx.user.id === l.owner_id || ctx.user.role === 'admin');
    if (l.status !== 'published' && l.status !== 'rented' && !isOwner) throw notFound('Listing not found.');

    if (l.status === 'published' && !isOwner) q.run('UPDATE listings SET views = views + 1 WHERE id = ?', l.id);

    const exact = canSeeExact(ctx.user, l);
    const lr = landlordRating(l.owner_id);
    const out = {
      id: l.id, owner_id: l.owner_id, title: l.title, description: l.description, type: l.type, price: l.price, period: l.period,
      deposit: l.deposit, service_charge: l.service_charge, beds: l.beds, baths: l.baths, size_sqm: l.size_sqm,
      furnished: !!l.furnished, amenities: l.amenities, city: l.city, area: l.area, available_from: l.available_from,
      min_lease_months: l.min_lease_months, rules: l.rules, video: l.video, status: l.status, views: isOwner ? l.views : undefined,
      published_at: l.published_at, avg_property: l.avg_property, n_property: l.n_property || 0,
      rooms: l.rooms, photos: l.photos,
      address: exact ? l.address : null, exact_location: exact,
      lat: exact ? l.lat : fuzz(l.lat), lng: exact ? l.lng : fuzz(l.lng),
      owner: {
        id: l.owner_id, name: l.owner_name, avatar: l.owner_avatar, verified: !!l.owner_verified, since: l.owner_since,
        rating: lr.avg, rating_count: lr.n,
        listings: q.get("SELECT COUNT(*) c FROM listings WHERE owner_id = ? AND status = 'published'", l.owner_id).c,
      },
      is_owner: !!isOwner,
    };
    if (isOwner) Object.assign(out, { raw: { address: l.address, lat: l.lat, lng: l.lng } });
    if (ctx.user) {
      out.favorited = !!q.get('SELECT 1 FROM favorites WHERE user_id = ? AND listing_id = ?', ctx.user.id, l.id);
      const seen = q.all('SELECT room_id FROM tour_progress WHERE user_id = ? AND listing_id = ?', ctx.user.id, l.id).map((x) => x.room_id);
      out.tour_seen = seen;
      out.tour_required = l.rooms.length ? l.rooms.map((x) => x.id) : (l.video ? [0] : []);
      out.tour_complete = out.tour_required.every((id) => seen.includes(id));
      out.my_viewing = q.get(
        "SELECT id,status,starts_at FROM viewings WHERE listing_id = ? AND tenant_id = ? AND status IN ('requested','confirmed','completed') ORDER BY id DESC LIMIT 1", l.id, ctx.user.id) || null;
      out.my_conversation = q.get('SELECT id FROM conversations WHERE listing_id = ? AND tenant_id = ?', l.id, ctx.user.id)?.id || null;
    }
    return out;
  });

  r.get('/api/landlords/:id', (ctx) => {
    const u = q.get("SELECT id,name,avatar,bio,created_at,verified_status FROM users WHERE id = ? AND role IN ('landlord','admin') AND suspended = 0", ctx.params.id);
    if (!u) throw notFound('Landlord not found.');
    const lr = landlordRating(u.id);
    const items = q.all(
      `SELECT l.*, ${OWNER_COLS}, rp.avg_property, rp.n_property,
        (SELECT path FROM photos ph WHERE ph.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover,
        (SELECT COUNT(*) FROM rooms rr WHERE rr.listing_id = l.id) AS room_count
       FROM listings l JOIN users u ON u.id = l.owner_id ${RATING_JOIN}
       WHERE l.owner_id = ? AND l.status = 'published' ORDER BY l.published_at DESC`, u.id).map(cardShape);
    const reviews = q.all(
      `SELECT r.id, r.rating_landlord, r.body, r.created_at, r.verified_visit, r.reply, r.replied_at, us.name AS author_name, l.title AS listing_title, l.id AS listing_id
       FROM reviews r JOIN users us ON us.id = r.author_id JOIN listings l ON l.id = r.listing_id
       WHERE l.owner_id = ? AND r.hidden = 0 AND r.rating_landlord IS NOT NULL ORDER BY r.id DESC LIMIT 30`, u.id);
    const rented = q.get("SELECT COUNT(*) c FROM listings WHERE owner_id = ? AND status = 'rented'", u.id).c;
    return { id: u.id, name: u.name, avatar: u.avatar, bio: u.bio, since: u.created_at, verified: u.verified_status === 'verified', rating: lr.avg, rating_count: lr.n, rented, listings: items, reviews };
  });

  // ------------------------------------------------------------- tour tracking (powers the "tour before visit" rule)
  r.post('/api/listings/:id/tour-progress', requireAuth, (ctx) => {
    const l = q.get("SELECT id FROM listings WHERE id = ? AND status IN ('published','rented')", ctx.params.id);
    if (!l) throw notFound();
    const roomId = int(ctx.body.room_id, { min: 0, field: 'Room' });
    if (roomId !== 0 && !q.get('SELECT 1 FROM rooms WHERE id = ? AND listing_id = ?', roomId, l.id)) throw bad('Unknown room.');
    q.run('INSERT OR IGNORE INTO tour_progress (user_id,listing_id,room_id) VALUES (?,?,?)', ctx.user.id, l.id, roomId);
    const required = q.all('SELECT id FROM rooms WHERE listing_id = ?', l.id).map((x) => x.id);
    const need = required.length ? required : [0];
    const seen = q.all('SELECT room_id FROM tour_progress WHERE user_id = ? AND listing_id = ?', ctx.user.id, l.id).map((x) => x.room_id);
    return { seen, complete: need.every((id) => seen.includes(id)) };
  });

  // ------------------------------------------------------------- favourites
  r.post('/api/listings/:id/favorite', requireAuth, (ctx) => {
    if (!q.get('SELECT id FROM listings WHERE id = ?', ctx.params.id)) throw notFound();
    q.run('INSERT OR IGNORE INTO favorites (user_id,listing_id) VALUES (?,?)', ctx.user.id, ctx.params.id);
    return { favorited: true };
  });
  r.delete('/api/listings/:id/favorite', requireAuth, (ctx) => {
    q.run('DELETE FROM favorites WHERE user_id = ? AND listing_id = ?', ctx.user.id, ctx.params.id);
    return { favorited: false };
  });
  r.get('/api/favorites', requireAuth, (ctx) => {
    const rows = q.all(
      `SELECT l.*, ${OWNER_COLS}, rp.avg_property, rp.n_property,
        (SELECT path FROM photos ph WHERE ph.listing_id = l.id ORDER BY position, id LIMIT 1) AS cover,
        (SELECT COUNT(*) FROM rooms rr WHERE rr.listing_id = l.id) AS room_count
       FROM favorites f JOIN listings l ON l.id = f.listing_id JOIN users u ON u.id = l.owner_id ${RATING_JOIN}
       WHERE f.user_id = ? AND l.status IN ('published','rented') ORDER BY f.created_at DESC`, ctx.user.id);
    return { items: rows.map(cardShape) };
  });

  // ------------------------------------------------------------- landlord dashboard stats
  r.get('/api/my/stats', requireRole('landlord', 'admin'), (ctx) => {
    const id = ctx.user.id;
    return {
      listings: q.get("SELECT COUNT(*) c FROM listings WHERE owner_id = ? AND status = 'published'", id).c,
      views: q.get('SELECT COALESCE(SUM(views),0) c FROM listings WHERE owner_id = ?', id).c,
      saves: q.get('SELECT COUNT(*) c FROM favorites f JOIN listings l ON l.id = f.listing_id WHERE l.owner_id = ?', id).c,
      inquiries: q.get('SELECT COUNT(*) c FROM conversations WHERE landlord_id = ?', id).c,
      pending_viewings: q.get("SELECT COUNT(*) c FROM viewings WHERE landlord_id = ? AND status = 'requested'", id).c,
      upcoming_viewings: q.get("SELECT COUNT(*) c FROM viewings WHERE landlord_id = ? AND status = 'confirmed' AND starts_at > ?", id, new Date().toISOString()).c,
      rating: landlordRating(id),
    };
  });
};

module.exports.loadFull = loadFull;
