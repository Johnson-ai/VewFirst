'use strict';
// Usage: npm run seed            (adds demo data once)
//        npm run seed -- --reset (wipes the database first)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('../src/config');

if (process.argv.includes('--reset')) {
  for (const f of ['viewfirst.db', 'viewfirst.db-wal', 'viewfirst.db-shm']) fs.rmSync(path.join(cfg.dataDir, f), { force: true });
  fs.rmSync(cfg.uploadDir, { recursive: true, force: true });
  fs.rmSync(cfg.privateDir, { recursive: true, force: true });
}

const { q, tx } = require('../src/db');
const { hashPassword, ensureAdmin } = require('../src/auth');

ensureAdmin();
if (q.get("SELECT id FROM users WHERE email = 'landlord@demo.local'")) {
  console.log('Demo data already present. Run `npm run seed -- --reset` to start over.');
  process.exit(0);
}

const sampleDir = path.join(__dirname, '..', 'public', 'sample');
if (!fs.existsSync(path.join(sampleDir, 'pano_living_a.jpg'))) {
  console.error('Sample images missing. Run: python3 scripts/make_panoramas.py');
  process.exit(1);
}

// Copy a sample image into uploads under a random name (once per sample).
const copied = {};
function upload(name, dir = cfg.uploadDir, prefix = '/uploads/') {
  const key = `${dir}:${name}`;
  if (copied[key]) return copied[key];
  const file = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  fs.copyFileSync(path.join(sampleDir, name), path.join(dir, file));
  return (copied[key] = `${prefix}${file}`);
}
const pano = (n) => upload(`pano_${n}.jpg`);
const photo = (n) => upload(`photo_${n}.jpg`);
const privateDoc = (n) => upload(`photo_${n}.jpg`, cfg.privateDir, 'private:');

const pw = hashPassword('demo-password-123');
const user = (email, name, role, phone, extra = {}) => Number(q.run(
  `INSERT INTO users (email,name,phone,password_hash,role,verified_status,verified_at,bio) VALUES (?,?,?,?,?,?,?,?)`,
  email, name, phone, pw, role, extra.status || 'none', extra.status === 'verified' ? new Date().toISOString() : null, extra.bio || null).lastInsertRowid);

const adaId = user('landlord@demo.local', 'Adaeze Okonkwo', 'landlord', '+234 803 000 0001', { status: 'verified', bio: 'I own and manage a handful of flats in Lagos. I answer messages the same day and never ask for money before a viewing.' });
const kolaId = user('kola@demo.local', 'Kola Balogun', 'landlord', '+234 803 000 0002', { status: 'verified', bio: 'Property owner in Abuja. Direct-to-tenant, no agent fees.' });
const pendingId = user('pending@demo.local', 'Ibrahim Sani', 'landlord', '+234 803 000 0003', { status: 'pending' });
const tobiId = user('tenant@demo.local', 'Tobi Adeyemi', 'tenant', '+234 803 000 0004');
const chiId = user('chi@demo.local', 'Chidinma Eze', 'tenant', '+234 803 000 0005');

q.run('INSERT INTO verifications (user_id,id_type,id_doc,ownership_doc,ownership_note) VALUES (?,?,?,?,?)',
  pendingId, 'national_id', privateDoc('bathroom'), privateDoc('kitchen'), 'Deed of assignment for the Gwarinpa property (demo placeholder document).');

const LISTINGS = [
  {
    owner: adaId, title: 'Bright 2-bedroom flat in Yaba, ten minutes to the mainland bridge', type: 'apartment', price: 1800000, period: 'year',
    deposit: 200000, service_charge: 150000, beds: 2, baths: 2, size: 96, furnished: 0, city: 'Lagos', area: 'Yaba',
    address: '12 Herbert Macaulay Way, Yaba', lat: 6.5095, lng: 3.3711, from: '2026-11-01', lease: 12,
    amenities: ['Water supply', 'Prepaid meter', 'Security / gate', 'Parking', 'Wardrobes', 'Tiled floors', 'Internet ready'],
    description: 'Second-floor flat in a quiet compound with a night guard. Two bedrooms with fitted wardrobes, a tiled kitchen, and a balcony facing the street. Borehole water, a prepaid meter that is yours alone, and space for two cars.\n\nThe tour shows every room. Please check the kitchen and the second bathroom, which tenants usually ask about.',
    rules: 'No loud events after 10pm. Pets allowed with a short conversation first.',
    rooms: [['Living room', 'living_a'], ['Main bedroom', 'bedroom_a'], ['Kitchen', 'kitchen'], ['Bathroom', 'bathroom']],
    photos: ['living_a', 'bedroom_a', 'kitchen', 'bathroom'],
  },
  {
    owner: adaId, title: 'Newly furnished studio in Lekki Phase 1', type: 'studio', price: 650000, period: 'month',
    deposit: 650000, service_charge: 0, beds: 1, baths: 1, size: 42, furnished: 1, city: 'Lagos', area: 'Lekki Phase 1',
    address: '7 Admiralty Way, Lekki Phase 1', lat: 6.4474, lng: 3.4723, from: '2026-10-15', lease: 6,
    amenities: ['Water supply', '24h power / generator', 'Air conditioning', 'Fitted kitchen', 'Security / gate', 'CCTV', 'Internet ready', 'Elevator'],
    description: 'A compact, fully furnished studio for one person or a couple. Generator and inverter cover the whole flat, so the lights stay on. The building has CCTV, a front desk and a lift. Rent is paid monthly with a refundable month of deposit.',
    rules: 'No smoking indoors. Minimum six months.',
    rooms: [['Studio', 'living_c'], ['Bathroom', 'bathroom']],
    photos: ['living_c', 'kitchen', 'bathroom'],
  },
  {
    owner: adaId, title: 'Family 3-bedroom bungalow with garden in Surulere', type: 'bungalow', price: 3200000, period: 'year',
    deposit: 300000, service_charge: 120000, beds: 3, baths: 3, size: 160, furnished: 0, city: 'Lagos', area: 'Surulere',
    address: '4 Bode Thomas Close, Surulere', lat: 6.501, lng: 3.3569, from: '2026-12-01', lease: 12,
    amenities: ['Water supply', 'Prepaid meter', 'Security / gate', 'Parking', 'Garden', 'Boys quarters / BQ', 'Wardrobes', 'Solar / inverter'],
    description: 'A detached bungalow on a quiet close, with a walled garden and boys quarters. Three bedrooms, three bathrooms, a large living room and a separate dining area. Solar panels run the lights and fans during outages.',
    rules: 'Family tenants preferred. Garden upkeep is shared.',
    rooms: [['Living room', 'living_b'], ['Master bedroom', 'bedroom_b'], ['Kitchen', 'kitchen']],
    photos: ['living_b', 'bedroom_b', 'kitchen'],
  },
  {
    owner: kolaId, title: 'Serviced 2-bedroom apartment in Wuse II, Abuja', type: 'apartment', price: 4500000, period: 'year',
    deposit: 450000, service_charge: 300000, beds: 2, baths: 2, size: 110, furnished: 1, city: 'Abuja', area: 'Wuse II',
    address: '21 Aminu Kano Crescent, Wuse II', lat: 9.082, lng: 7.477, from: '2026-11-15', lease: 12,
    amenities: ['Water supply', '24h power / generator', 'Security / gate', 'CCTV', 'Parking', 'Air conditioning', 'Fitted kitchen', 'Gym', 'Elevator', 'Waste disposal'],
    description: 'A serviced apartment in a gated block with a gym, 24-hour power and waste collection. Furnished to a clean, neutral standard. Walking distance to restaurants, banks and the Wuse market.',
    rules: 'Service charge covers security, power backup and waste. No commercial use.',
    rooms: [['Living room', 'living_c'], ['Bedroom', 'bedroom_c'], ['Kitchen', 'kitchen'], ['Bathroom', 'bathroom']],
    photos: ['living_c', 'bedroom_c', 'kitchen', 'bathroom'],
  },
  {
    owner: kolaId, title: 'Affordable self-contained room in Gwarinpa', type: 'room', price: 480000, period: 'year',
    deposit: 0, service_charge: 30000, beds: 1, baths: 1, size: 24, furnished: 0, city: 'Abuja', area: 'Gwarinpa',
    address: '3rd Avenue, Gwarinpa Estate', lat: 9.1108, lng: 7.4056, from: '2026-10-20', lease: 12,
    amenities: ['Water supply', 'Prepaid meter', 'Security / gate', 'Tiled floors'],
    description: 'A clean self-contained room with its own bathroom and a private entrance. Prepaid meter, borehole water and an estate security post at the gate. Suitable for a single working tenant or student.',
    rules: 'One occupant. No cooking with open fires.',
    rooms: [['Room', 'bedroom_a'], ['Bathroom', 'bathroom']],
    photos: ['bedroom_a', 'bathroom'],
  },
];

const ids = tx(() => LISTINGS.map((L, idx) => {
  const id = Number(q.run(
    `INSERT INTO listings (owner_id,title,description,type,price,period,deposit,service_charge,beds,baths,size_sqm,furnished,amenities,city,area,address,lat,lng,available_from,min_lease_months,rules,status,published_at,views)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'published',datetime('now', ?),?)`,
    L.owner, L.title, L.description, L.type, L.price, L.period, L.deposit, L.service_charge, L.beds, L.baths, L.size, L.furnished,
    JSON.stringify(L.amenities), L.city, L.area, L.address, L.lat, L.lng, L.from, L.lease, L.rules, `-${idx} days`, 40 + idx * 17).lastInsertRowid);
  L.photos.forEach((p, i) => q.run('INSERT INTO photos (listing_id,path,position) VALUES (?,?,?)', id, photo(p), i));
  L.rooms.forEach(([name, p], i) => q.run('INSERT INTO rooms (listing_id,name,panorama,pano_w,pano_h,position) VALUES (?,?,?,?,?,?)', id, name, pano(p), 2560, 1280, i));
  return id;
}));

// Viewing slots (next days, 10:00 and 14:00 UTC)
for (const id of ids) {
  for (let d = 2; d <= 6; d++) {
    for (const hour of [10, 14]) {
      const t = new Date(); t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(hour, 0, 0, 0);
      q.run('INSERT OR IGNORE INTO viewing_slots (listing_id,starts_at,duration_min) VALUES (?,?,30)', id, t.toISOString());
    }
  }
}

// Reviews, comments, messages
q.run('INSERT INTO reviews (listing_id,author_id,rating_property,rating_landlord,body,verified_visit,reply,replied_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\'))',
  ids[0], tobiId, 4, 5, 'The flat is exactly like the tour. The kitchen is a little smaller than it looks in the 360 view, but the landlord was on time and honest about it. No agent fee was a big relief.', 1,
  'Thank you Tobi, glad the viewing matched the tour. Good luck with the move!');
q.run('INSERT INTO reviews (listing_id,author_id,rating_property,rating_landlord,body,verified_visit) VALUES (?,?,?,?,?,?)',
  ids[0], chiId, 5, 5, 'Toured on my phone from another city, booked one viewing and signed the same week. Saved me a lot of transport money.', 1);
q.run('INSERT INTO reviews (listing_id,author_id,rating_property,rating_landlord,body,verified_visit) VALUES (?,?,?,?,?,?)',
  ids[1], tobiId, 3, 4, 'Nice studio and a reliable generator. Priced on the high side for the size, but the building is secure.', 0);

const c1 = Number(q.run('INSERT INTO comments (listing_id,author_id,body) VALUES (?,?,?)', ids[0], tobiId, 'Is the water from a borehole or the mains? And is there a water treatment tank?').lastInsertRowid);
q.run('INSERT INTO comments (listing_id,author_id,parent_id,body) VALUES (?,?,?,?)', ids[0], adaId, c1, 'Borehole, with a treatment tank that was serviced this year. Water runs every day.');
q.run('INSERT INTO comments (listing_id,author_id,body) VALUES (?,?,?)', ids[0], chiId, 'Is the rent negotiable if I pay for two years upfront?');

const conv = Number(q.run('INSERT INTO conversations (listing_id,tenant_id,landlord_id) VALUES (?,?,?)', ids[1], tobiId, adaId).lastInsertRowid);
q.run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', conv, tobiId, 'Hello, is the studio still available from 15 October?');
q.run('INSERT INTO messages (conversation_id,sender_id,body) VALUES (?,?,?)', conv, adaId, 'Yes it is. Have a look at the full tour and book a viewing slot when you are ready.');

console.log('\nDemo data created.\n');
console.log('  Landlord (verified):  landlord@demo.local / demo-password-123');
console.log('  Landlord (verified):  kola@demo.local     / demo-password-123');
console.log('  Landlord (pending):   pending@demo.local  / demo-password-123');
console.log('  Tenant:               tenant@demo.local   / demo-password-123');
console.log('  Tenant:               chi@demo.local      / demo-password-123');
console.log(`  Admin:                ${cfg.adminEmail} / (your ADMIN_PASSWORD)\n`);
