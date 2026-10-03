'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Tiny .env loader so the project needs zero dependencies.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');
const root = path.join(__dirname, '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || './data');

module.exports = {
  root,
  port: Number(process.env.PORT || 3000),
  appName: process.env.APP_NAME || 'ViewFirst',
  currency: process.env.CURRENCY || 'NGN',
  locale: process.env.LOCALE || 'en-NG',
  mapCenter: [Number(process.env.MAP_CENTER_LAT || 6.5244), Number(process.env.MAP_CENTER_LNG || 3.3792)],
  requireVerification: bool(process.env.REQUIRE_VERIFICATION, true),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@viewfirst.local',
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me-now-please',
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  dataDir,
  uploadDir: path.join(dataDir, 'uploads'),
  privateDir: path.join(dataDir, 'private'),
  publicDir: path.join(root, 'public'),
  sessionDays: 30,
  limits: { photo: 10, pano: 25, video: 60, doc: 10, avatar: 4 }, // MB
  listingTypes: ['apartment', 'house', 'duplex', 'bungalow', 'studio', 'room', 'townhouse', 'shop'],
  amenities: [
    'Water supply', 'Prepaid meter', '24h power / generator', 'Solar / inverter', 'Security / gate',
    'CCTV', 'Parking', 'Air conditioning', 'Fitted kitchen', 'Wardrobes', 'Balcony', 'Garden',
    'Swimming pool', 'Gym', 'Internet ready', 'Pet friendly', 'Waste disposal', 'Tiled floors',
    'POP ceiling', 'Elevator', 'Wheelchair access', 'Boys quarters / BQ'
  ]
};
