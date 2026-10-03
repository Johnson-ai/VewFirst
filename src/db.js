'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(cfg.uploadDir, { recursive: true });
fs.mkdirSync(cfg.privateDir, { recursive: true });

const db = new DatabaseSync(path.join(cfg.dataDir, 'viewfirst.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  bio TEXT,
  avatar TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('tenant','landlord','admin')),
  verified_status TEXT NOT NULL DEFAULT 'none' CHECK (verified_status IN ('none','pending','verified','rejected')),
  verified_at TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_type TEXT NOT NULL,
  id_doc TEXT NOT NULL,
  selfie_doc TEXT,
  ownership_doc TEXT NOT NULL,
  ownership_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'apartment',
  price INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'year' CHECK (period IN ('month','year')),
  deposit INTEGER NOT NULL DEFAULT 0,
  service_charge INTEGER NOT NULL DEFAULT 0,
  beds INTEGER NOT NULL DEFAULT 1,
  baths INTEGER NOT NULL DEFAULT 1,
  size_sqm INTEGER,
  furnished INTEGER NOT NULL DEFAULT 0,
  amenities TEXT NOT NULL DEFAULT '[]',
  city TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  available_from TEXT,
  min_lease_months INTEGER NOT NULL DEFAULT 12,
  rules TEXT NOT NULL DEFAULT '',
  video TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','rented','archived','removed')),
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings(owner_id);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  panorama TEXT NOT NULL,
  pano_w INTEGER NOT NULL DEFAULT 0,
  pano_h INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rooms_listing ON rooms(listing_id, position);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_photos_listing ON photos(listing_id, position);

CREATE TABLE IF NOT EXISTS tour_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL,           -- 0 = video walkthrough
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, listing_id, room_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (listing_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS viewing_slots (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','held','booked')),
  UNIQUE (listing_id, starts_at)
);

CREATE TABLE IF NOT EXISTS viewings (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  slot_id INTEGER REFERENCES viewing_slots(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','cancelled','completed')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_viewings_tenant ON viewings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_viewings_landlord ON viewings(landlord_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating_property INTEGER CHECK (rating_property BETWEEN 1 AND 5),
  rating_landlord INTEGER CHECK (rating_landlord BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  verified_visit INTEGER NOT NULL DEFAULT 0,
  reply TEXT,
  replied_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (listing_id, author_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_listing ON comments(listing_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, id DESC);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('listing','comment','review','user')),
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
`);

/** Run fn inside a transaction; rolls back on throw. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

function notify(userId, type, title, body, link) {
  q.run('INSERT INTO notifications (user_id,type,title,body,link) VALUES (?,?,?,?,?)', userId, type, title, body || null, link || null);
}

module.exports = { db, tx, q, notify };
