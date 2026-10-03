'use strict';
const cfg = require('../config');
const { q } = require('../db');
const { bad, str, oneOf, rateLimit } = require('../http');
const { hashPassword, verifyPassword, createSession, destroySession, publicUser, requireAuth } = require('../auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = (r) => {
  r.post('/api/auth/register', (ctx) => {
    rateLimit(`reg:${ctx.ip}`, 10, 60 * 60_000);
    const b = ctx.body;
    const name = str(b.name, { min: 2, max: 80, field: 'Name' });
    const email = str(b.email, { min: 3, max: 160, field: 'Email' }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    const password = str(b.password, { min: 8, max: 200, field: 'Password', trim: false });
    const role = oneOf(b.role || 'tenant', ['tenant', 'landlord'], 'Role');
    const phone = str(b.phone, { max: 30, field: 'Phone' });
    if (q.get('SELECT id FROM users WHERE email = ?', email)) throw bad('An account with this email already exists. Try logging in.');
    const info = q.run('INSERT INTO users (email,name,phone,password_hash,role) VALUES (?,?,?,?,?)', email, name, phone || null, hashPassword(password), role);
    createSession(ctx.res, Number(info.lastInsertRowid));
    ctx.status = 201;
    return { user: publicUser(q.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)) };
  });

  r.post('/api/auth/login', (ctx) => {
    const email = str(ctx.body.email, { min: 1, max: 160, field: 'Email' }).toLowerCase();
    rateLimit(`login:${ctx.ip}`, 20, 10 * 60_000);
    rateLimit(`login:${email}`, 8, 10 * 60_000);
    const u = q.get('SELECT * FROM users WHERE email = ?', email);
    const ok = u && verifyPassword(String(ctx.body.password || ''), u.password_hash);
    if (!ok) throw bad('Email or password is incorrect.');
    if (u.suspended) throw bad('This account has been suspended. Contact support.');
    createSession(ctx.res, u.id);
    return { user: publicUser(u) };
  });

  r.post('/api/auth/logout', (ctx) => { destroySession(ctx.req, ctx.res); return { ok: true }; });

  r.get('/api/me', (ctx) => ({ user: publicUser(ctx.user) }));

  r.patch('/api/me', requireAuth, (ctx) => {
    const b = ctx.body;
    const name = str(b.name ?? ctx.user.name, { min: 2, max: 80, field: 'Name' });
    const phone = str(b.phone ?? ctx.user.phone, { max: 30, field: 'Phone' });
    const bio = str(b.bio ?? ctx.user.bio, { max: 600, field: 'Bio' });
    let avatar = ctx.user.avatar;
    if (b.avatar !== undefined) {
      if (b.avatar && !/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(b.avatar)) throw bad('Invalid avatar.');
      avatar = b.avatar || null;
    }
    q.run('UPDATE users SET name=?, phone=?, bio=?, avatar=? WHERE id=?', name, phone || null, bio || null, avatar, ctx.user.id);
    return { user: publicUser(q.get('SELECT * FROM users WHERE id = ?', ctx.user.id)) };
  });

  r.post('/api/me/password', requireAuth, (ctx) => {
    rateLimit(`pw:${ctx.user.id}`, 5, 10 * 60_000);
    if (!verifyPassword(String(ctx.body.current || ''), ctx.user.password_hash)) throw bad('Current password is incorrect.');
    const next = str(ctx.body.next, { min: 8, max: 200, field: 'New password', trim: false });
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), ctx.user.id);
    return { ok: true };
  });

  // Public site configuration the frontend needs.
  r.get('/api/meta', () => ({
    appName: cfg.appName, currency: cfg.currency, locale: cfg.locale, mapCenter: cfg.mapCenter,
    listingTypes: cfg.listingTypes, amenities: cfg.amenities, requireVerification: cfg.requireVerification,
    limits: cfg.limits,
  }));
};
