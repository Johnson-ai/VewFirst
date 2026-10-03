'use strict';
const crypto = require('node:crypto');
const cfg = require('./config');
const { q } = require('./db');
const { parseCookies, setCookie, unauthorized, forbidden } = require('./http');

const COOKIE = 'vf_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + cfg.sessionDays * 864e5);
  q.run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', sha(token), userId, expires.toISOString());
  setCookie(res, COOKIE, token, { maxAgeSec: cfg.sessionDays * 86400 });
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) q.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  setCookie(res, COOKIE, '', { clear: true });
}

/** Resolve the logged-in user for a request (or null). */
function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = q.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`, sha(token), new Date().toISOString());
  if (!row || row.suspended) return null;
  return row;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, bio: u.bio, avatar: u.avatar,
    role: u.role, verified: u.verified_status === 'verified', verified_status: u.verified_status,
    created_at: u.created_at,
  };
}

const requireAuth = (ctx) => { if (!ctx.user) throw unauthorized(); };
const requireRole = (...roles) => (ctx) => {
  if (!ctx.user) throw unauthorized();
  if (!roles.includes(ctx.user.role)) throw forbidden();
};

function ensureAdmin() {
  const exists = q.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (exists) return;
  q.run(
    "INSERT INTO users (email,name,password_hash,role,verified_status) VALUES (?,?,?,'admin','verified')",
    cfg.adminEmail, 'Platform admin', hashPassword(cfg.adminPassword));
  console.log(`[viewfirst] Created admin account ${cfg.adminEmail}`);
  if (cfg.adminPassword === 'change-me-now-please') {
    console.warn('[viewfirst] WARNING: using the default admin password. Set ADMIN_PASSWORD in .env.');
  }
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, currentUser, publicUser, requireAuth, requireRole, ensureAdmin };
