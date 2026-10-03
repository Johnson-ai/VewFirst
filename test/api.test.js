'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-password-123';

const server = require('../server');
let base;

// Tiny 2:1 JPEG header so the dimension parser has something real to read (SOF0: 64x32).
const jpeg = (w, h) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.from([0xff, 0xd9]),
]);

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { 'X-Requested-With': 'viewfirst', ...(isRaw ? {} : { 'Content-Type': 'application/json' }), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const [kv] = c.split(';'); if (kv.startsWith('vf_session=')) this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
}

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const S = {}; // shared state across ordered tests

test('registration, login and validation', async () => {
  S.landlord = new Client(); S.tenant = new Client(); S.tenant2 = new Client(); S.admin = new Client();
  let r = await S.landlord.post('/api/auth/register', { name: 'Ada Landlord', email: 'ada@test.com', password: 'password123', role: 'landlord' });
  assert.equal(r.status, 201); assert.equal(r.data.user.role, 'landlord');
  r = await S.tenant.post('/api/auth/register', { name: 'Tobi Tenant', email: 'tobi@test.com', password: 'password123', role: 'tenant' });
  assert.equal(r.status, 201);
  r = await S.tenant2.post('/api/auth/register', { name: 'Chi Tenant', email: 'chi@test.com', password: 'password123' });
  assert.equal(r.status, 201);
  r = await new Client().post('/api/auth/register', { name: 'X', email: 'bad', password: 'short' });
  assert.equal(r.status, 400);
  r = await new Client().post('/api/auth/register', { name: 'Dup', email: 'ada@test.com', password: 'password123' });
  assert.equal(r.status, 400);
  r = await new Client().post('/api/auth/register', { name: 'Hax', email: 'hax@test.com', password: 'password123', role: 'admin' });
  assert.equal(r.status, 400, 'cannot self-register as admin');
  r = await S.admin.post('/api/auth/login', { email: 'admin@test.local', password: 'admin-password-123' });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin');
  r = await new Client().post('/api/auth/login', { email: 'ada@test.com', password: 'wrong-password' });
  assert.equal(r.status, 400);
  r = await S.landlord.get('/api/me');
  assert.equal(r.data.user.email, 'ada@test.com');
});

test('CSRF guards: missing header and foreign origin are rejected', async () => {
  let res = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'viewfirst', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('uploads: magic-byte validation and image dimensions', async () => {
  let r = await S.landlord.req('POST', '/api/upload?kind=pano', Buffer.from('not an image at all, just text'), { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 400);
  r = await S.landlord.req('POST', '/api/upload?kind=pano', jpeg(64, 32), { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 201);
  assert.equal(r.data.width, 64); assert.equal(r.data.height, 32);
  S.pano1 = r.data.path;
  r = await S.landlord.req('POST', '/api/upload?kind=pano', jpeg(128, 64), { 'Content-Type': 'application/octet-stream' });
  S.pano2 = r.data.path;
  r = await S.landlord.req('POST', '/api/upload?kind=photo', jpeg(100, 80), { 'Content-Type': 'application/octet-stream' });
  S.photo = r.data.path;
  r = await new Client().req('POST', '/api/upload?kind=photo', jpeg(10, 10), { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 401);
  const file = await fetch(base + S.photo);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  const traversal = await fetch(base + '/uploads/..%2f..%2fetc%2fpasswd');
  assert.equal(traversal.status, 404);
});

test('tenants cannot create listings; landlord creates a draft', async () => {
  let r = await S.tenant.post('/api/listings', { title: 'Nope nope' });
  assert.equal(r.status, 403);
  r = await S.landlord.post('/api/listings', {
    title: 'Bright 2-bed in Yaba', description: 'Close to the main road.', type: 'apartment', price: 1800000, period: 'year',
    deposit: 200000, service_charge: 100000, beds: 2, baths: 2, city: 'Lagos', area: 'Yaba', address: '12 Herbert Macaulay Way',
    lat: 6.5095123, lng: 3.3711456, amenities: ['Water supply', 'Parking'],
    photos: [S.photo], rooms: [{ name: 'Living room', panorama: S.pano1 }, { name: 'Bedroom', panorama: S.pano2 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  S.listingId = r.data.id;
  r = await S.landlord.get(`/api/listings/${S.listingId}`);
  assert.equal(r.data.rooms.length, 2);
  assert.equal(r.data.rooms[0].pano_w, 64);
  S.rooms = r.data.rooms;
  // drafts are invisible to the public
  assert.equal((await new Client().get(`/api/listings/${S.listingId}`)).status, 404);
});

test('publishing requires an approved verification', async () => {
  let r = await S.landlord.post(`/api/listings/${S.listingId}/status`, { status: 'published' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /verification/i);

  // upload private docs and submit
  const doc = async () => (await S.landlord.req('POST', '/api/upload?kind=doc', jpeg(50, 50), { 'Content-Type': 'application/octet-stream' })).data.path;
  const idDoc = await doc(); const own = await doc();
  assert.match(idDoc, /^private:/);
  r = await S.landlord.post('/api/verification', { id_type: 'national_id', id_doc: idDoc, ownership_doc: own, ownership_note: 'Land title' });
  assert.equal(r.status, 201);
  assert.equal((await S.landlord.get('/api/me')).data.user.verified_status, 'pending');
  // docs are private
  const file = idDoc.slice(8);
  assert.equal((await S.tenant.get(`/api/private/${file}`)).status, 403);
  assert.equal((await new Client().get(`/api/private/${file}`)).status, 401);
  assert.equal((await S.landlord.get(`/api/private/${file}`)).status, 200);
  assert.equal((await S.admin.get(`/api/private/${file}`)).status, 200);

  // admin must explain rejections
  const list = await S.admin.get('/api/admin/verifications');
  assert.equal(list.data.items.length, 1);
  const vid = list.data.items[0].id;
  assert.equal((await S.landlord.get('/api/admin/verifications')).status, 403);
  r = await S.admin.post(`/api/admin/verifications/${vid}/decision`, { decision: 'rejected' });
  assert.equal(r.status, 400);
  r = await S.admin.post(`/api/admin/verifications/${vid}/decision`, { decision: 'approved' });
  assert.equal(r.status, 200);
  assert.equal((await S.landlord.get('/api/me')).data.user.verified, true);

  r = await S.landlord.post(`/api/listings/${S.listingId}/status`, { status: 'published' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('search, filters and public coordinate fuzzing', async () => {
  const anon = new Client();
  let r = await anon.get('/api/listings');
  assert.equal(r.data.total, 1);
  assert.equal(r.data.items[0].owner.verified, true);
  assert.equal(r.data.items[0].lat, 6.51); // rounded to ~110 m
  r = await anon.get('/api/listings?min_price=2000000'); assert.equal(r.data.total, 0);
  r = await anon.get('/api/listings?beds=2&verified=1&tour=1'); assert.equal(r.data.total, 1);
  r = await anon.get('/api/listings?beds=3'); assert.equal(r.data.total, 0);
  r = await anon.get('/api/listings?q=Yaba'); assert.equal(r.data.total, 1);
  r = await anon.get('/api/listings?amenity=Parking'); assert.equal(r.data.total, 1);
  r = await anon.get('/api/listings?amenity=Swimming%20pool'); assert.equal(r.data.total, 0);
  r = await anon.get("/api/listings?q=' OR 1=1 --"); assert.equal(r.data.total, 0);
  r = await anon.get(`/api/listings/${S.listingId}`);
  assert.equal(r.data.address, null, 'exact address is hidden');
  assert.equal(r.data.exact_location, false);
});

test('viewing booking is blocked until the whole tour is seen', async () => {
  // landlord slots
  const future = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  let r = await S.landlord.post(`/api/listings/${S.listingId}/slots`, { times: [future(48), future(72)], duration_min: 30 });
  assert.equal(r.status, 201); assert.equal(r.data.added, 2);
  r = await S.tenant.get(`/api/listings/${S.listingId}/slots`);
  assert.equal(r.data.slots.length, 2);
  const slotId = r.data.slots[0].id;

  r = await S.tenant.post(`/api/listings/${S.listingId}/viewings`, { slot_id: slotId });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'TOUR_INCOMPLETE');

  r = await S.tenant.post(`/api/listings/${S.listingId}/tour-progress`, { room_id: S.rooms[0].id });
  assert.equal(r.data.complete, false);
  r = await S.tenant.post(`/api/listings/${S.listingId}/tour-progress`, { room_id: 99999 });
  assert.equal(r.status, 400);
  r = await S.tenant.post(`/api/listings/${S.listingId}/tour-progress`, { room_id: S.rooms[1].id });
  assert.equal(r.data.complete, true);

  r = await S.tenant.post(`/api/listings/${S.listingId}/viewings`, { slot_id: slotId, note: 'Can I bring my sister?' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  S.viewingId = r.data.id;
  // the slot is held, so a second tenant cannot take it
  await S.tenant2.post(`/api/listings/${S.listingId}/tour-progress`, { room_id: S.rooms[0].id });
  await S.tenant2.post(`/api/listings/${S.listingId}/tour-progress`, { room_id: S.rooms[1].id });
  r = await S.tenant2.post(`/api/listings/${S.listingId}/viewings`, { slot_id: slotId });
  assert.equal(r.status, 400);
  // landlord cannot book own place
  r = await S.landlord.post(`/api/listings/${S.listingId}/viewings`, { slot_id: slotId });
  assert.equal(r.status, 400);
});

test('landlord confirms viewing, then the exact address is revealed to that tenant only', async () => {
  let r = await S.tenant.post(`/api/viewings/${S.viewingId}/status`, { status: 'confirmed' });
  assert.equal(r.status, 400, 'tenant cannot confirm');
  r = await S.landlord.post(`/api/viewings/${S.viewingId}/status`, { status: 'confirmed' });
  assert.equal(r.status, 200);
  r = await S.tenant.get(`/api/listings/${S.listingId}`);
  assert.equal(r.data.address, '12 Herbert Macaulay Way');
  assert.equal(r.data.lat, 6.5095123);
  r = await S.tenant2.get(`/api/listings/${S.listingId}`);
  assert.equal(r.data.address, null);
  r = await S.tenant.get('/api/viewings');
  assert.equal(r.data.items[0].address, '12 Herbert Macaulay Way');
  const ics = await S.tenant.get(`/api/viewings/${S.viewingId}/ics`);
  assert.equal(ics.status, 200); assert.match(ics.data, /BEGIN:VEVENT/);
  // tenant2 cannot read it
  assert.equal((await S.tenant2.get(`/api/viewings/${S.viewingId}/ics`)).status, 403);
  // cancelled viewing frees the slot
  r = await S.tenant.post(`/api/viewings/${S.viewingId}/status`, { status: 'cancelled' });
  assert.equal(r.status, 200);
  r = await S.tenant2.get(`/api/listings/${S.listingId}/slots`);
  assert.equal(r.data.slots.length, 2);
  // re-book and confirm again so the verified-visit review works
  r = await S.tenant.post(`/api/listings/${S.listingId}/viewings`, { slot_id: r.data.slots[0].id });
  assert.equal(r.status, 201);
  await S.landlord.post(`/api/viewings/${r.data.id}/status`, { status: 'confirmed' });
});

test('reviews: one per person, verified-visit flag, landlord reply, no self-review', async () => {
  let r = await S.landlord.post(`/api/listings/${S.listingId}/reviews`, { rating_property: 5, body: 'My own place is great!' });
  assert.equal(r.status, 403);
  r = await new Client().post(`/api/listings/${S.listingId}/reviews`, { rating_property: 5, body: 'Anonymous review here' });
  assert.equal(r.status, 401);
  r = await S.tenant.post(`/api/listings/${S.listingId}/reviews`, { rating_property: 6, body: 'Out of range rating' });
  assert.equal(r.status, 400);
  r = await S.tenant.post(`/api/listings/${S.listingId}/reviews`, { rating_property: 4, rating_landlord: 5, body: 'Exactly as the tour showed. Landlord was on time.' });
  assert.equal(r.status, 201);
  S.reviewId = r.data.id;
  r = await S.tenant2.post(`/api/listings/${S.listingId}/reviews`, { rating_property: 3, body: 'Seen only through the tour, looks fine.' });
  assert.equal(r.status, 201);
  // updating does not create a duplicate
  r = await S.tenant2.post(`/api/listings/${S.listingId}/reviews`, { rating_property: 2, body: 'Changed my mind about the noise level.' });
  assert.equal(r.data.updated, true);
  r = await new Client().get(`/api/listings/${S.listingId}/reviews`);
  assert.equal(r.data.items.length, 2);
  const mine = r.data.items.find((i) => i.author_name === 'Tobi Tenant');
  const other = r.data.items.find((i) => i.author_name === 'Chi Tenant');
  assert.equal(mine.verified_visit, 1); assert.equal(other.verified_visit, 0);
  // reply rules
  assert.equal((await S.tenant.post(`/api/reviews/${S.reviewId}/reply`, { reply: 'I reply to myself' })).status, 403);
  assert.equal((await S.landlord.post(`/api/reviews/${S.reviewId}/reply`, { reply: 'Thank you Tobi!' })).status, 200);
  r = await new Client().get(`/api/listings/${S.listingId}`);
  assert.equal(r.data.n_property, 2); assert.equal(r.data.avg_property, 3);
  assert.equal(r.data.owner.rating, 5);
  r = await new Client().get(`/api/landlords/${r.data.owner.id}`);
  assert.equal(r.data.reviews.length, 1);
});

test('comments: threads, landlord tag, permissions', async () => {
  let r = await S.tenant.post(`/api/listings/${S.listingId}/comments`, { body: 'Is the water supply from a borehole?' });
  assert.equal(r.status, 201); const parent = r.data.id;
  r = await S.landlord.post(`/api/listings/${S.listingId}/comments`, { body: 'Yes, a borehole with a treatment tank.', parent_id: parent });
  assert.equal(r.status, 201); const reply = r.data.id;
  r = await S.tenant2.post(`/api/listings/${S.listingId}/comments`, { body: 'Thanks, that helps!', parent_id: reply });
  assert.equal(r.status, 201);
  r = await new Client().get(`/api/listings/${S.listingId}/comments`);
  assert.equal(r.data.items.length, 3);
  const lr = r.data.items.find((c) => c.id === reply);
  assert.equal(lr.is_landlord, true);
  assert.equal(r.data.items[2].parent_id, parent, 'threads stay one level deep');
  assert.equal((await new Client().post(`/api/listings/${S.listingId}/comments`, { body: 'anon' })).status, 401);
  assert.equal((await S.tenant2.del(`/api/comments/${parent}`)).status, 403);
  assert.equal((await S.tenant.del(`/api/comments/${parent}`)).status, 200);
  r = await new Client().get(`/api/listings/${S.listingId}/comments`);
  assert.equal(r.data.items.length, 0, 'replies disappear with their parent');
});

test('messaging: tenant starts, both sides read, outsiders are blocked, unread counters', async () => {
  let r = await S.tenant.post('/api/conversations', { listing_id: S.listingId, body: 'Is the rent negotiable?' });
  assert.equal(r.status, 201); S.convId = r.data.id;
  r = await S.landlord.get('/api/counters'); assert.ok(r.data.messages >= 1);
  r = await S.landlord.post(`/api/conversations/${S.convId}/messages`, { body: 'A little, for a 2-year lease.' });
  assert.equal(r.status, 201);
  r = await S.tenant.get(`/api/conversations/${S.convId}/messages`);
  assert.equal(r.data.items.length, 2);
  assert.equal(r.data.conversation.other.name, 'Ada Landlord');
  assert.equal((await S.tenant2.get(`/api/conversations/${S.convId}/messages`)).status, 403);
  assert.equal((await S.tenant2.post(`/api/conversations/${S.convId}/messages`, { body: 'hi' })).status, 403);
  r = await S.landlord.post('/api/conversations', { listing_id: S.listingId, body: 'self' });
  assert.equal(r.status, 400);
  // same tenant + listing reuses the thread
  r = await S.tenant.post('/api/conversations', { listing_id: S.listingId, body: 'Following up.' });
  assert.equal(r.data.id, S.convId);
  r = await S.landlord.get('/api/conversations');
  assert.equal(r.data.items.length, 1); assert.equal(r.data.items[0].unread, 2);
  await S.landlord.get(`/api/conversations/${S.convId}/messages`);
  assert.equal((await S.landlord.get('/api/conversations')).data.items[0].unread, 0);
});

test('favorites, notifications, XSS payloads stay as plain data', async () => {
  let r = await S.tenant.post(`/api/listings/${S.listingId}/favorite`);
  assert.equal(r.data.favorited, true);
  r = await S.tenant.get('/api/favorites'); assert.equal(r.data.items.length, 1);
  r = await S.tenant.del(`/api/listings/${S.listingId}/favorite`);
  assert.equal((await S.tenant.get('/api/favorites')).data.items.length, 0);
  r = await S.landlord.get('/api/notifications');
  assert.ok(r.data.items.length >= 3);
  await S.landlord.post('/api/notifications/read');
  assert.equal((await S.landlord.get('/api/counters')).data.notifications, 0);
  const xss = '<img src=x onerror=alert(1)>';
  r = await S.tenant.post(`/api/listings/${S.listingId}/comments`, { body: xss });
  const got = await S.tenant.get(`/api/listings/${S.listingId}/comments`);
  assert.equal(got.data.items[0].body, xss); // stored verbatim; the frontend renders it with textContent
});

test('reports and admin moderation', async () => {
  let r = await S.tenant2.post('/api/reports', { target_type: 'listing', target_id: S.listingId, reason: 'scam', details: 'asks for money upfront' });
  assert.equal(r.status, 201);
  assert.equal((await S.tenant2.post('/api/reports', { target_type: 'listing', target_id: S.listingId, reason: 'scam' })).status, 400, 'no duplicate open reports');
  r = await S.admin.get('/api/admin/stats');
  assert.equal(r.data.open_reports, 1); assert.equal(r.data.published, 1);
  r = await S.admin.get('/api/admin/reports'); const rid = r.data.items[0].id;
  assert.equal((await S.tenant.get('/api/admin/reports')).status, 403);
  r = await S.admin.post(`/api/admin/reports/${rid}/resolve`, { action: 'remove_content' });
  assert.equal(r.status, 200);
  assert.equal((await new Client().get(`/api/listings/${S.listingId}`)).status, 404, 'removed listings vanish');
  assert.equal((await S.landlord.post(`/api/listings/${S.listingId}/status`, { status: 'published' })).status, 403, 'owner cannot republish a removed listing');
  // suspend + sessions revoked
  const users = (await S.admin.get('/api/admin/users?q=Chi')).data.items;
  r = await S.admin.post(`/api/admin/users/${users[0].id}/suspend`, { suspended: true });
  assert.equal(r.data.suspended, true);
  assert.equal((await S.tenant2.get('/api/me')).data.user, null);
  r = await new Client().post('/api/auth/login', { email: 'chi@test.com', password: 'password123' });
  assert.equal(r.status, 400);
});

test('other people cannot edit or delete a landlord’s listing', async () => {
  const other = new Client();
  await other.post('/api/auth/register', { name: 'Eve Landlord', email: 'eve@test.com', password: 'password123', role: 'landlord' });
  assert.equal((await other.put(`/api/listings/${S.listingId}`, { title: 'Hijacked title!' })).status, 403);
  assert.equal((await other.del(`/api/listings/${S.listingId}`)).status, 403);
  assert.equal((await S.tenant.put(`/api/listings/${S.listingId}`, { title: 'Hijacked title!' })).status, 403);
});
