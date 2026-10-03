'use strict';
const cfg = require('./config');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (m, extra) => new HttpError(400, m, extra);
const unauthorized = (m = 'Please log in to continue.') => new HttpError(401, m);
const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
const notFound = (m = 'Not found.') => new HttpError(404, m);

// ---------------------------------------------------------------- router
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { handlers: r.handlers, params };
      }
    }
    return null;
  }
  hasPath(pathname) { return this.routes.some((r) => r.re.test(pathname)); }
}

// ---------------------------------------------------------------- request helpers
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxBytes) { req.resume(); return reject(new HttpError(413, 'That file is too large.')); }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('Request body must be valid JSON.'); }
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function setCookie(res, name, value, { maxAgeSec, clear } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (cfg.cookieSecure) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else if (maxAgeSec) parts.push(`Max-Age=${maxAgeSec}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, parts.join('; ')) : parts.join('; '));
}

// ---------------------------------------------------------------- rate limiting
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) throw new HttpError(429, 'Too many attempts. Please wait a moment and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60_000).unref();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- validation helpers
const str = (v, { min = 0, max = 2000, field = 'Field', trim = true } = {}) => {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  if (trim) v = v.trim();
  if (v.length < min) throw bad(min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (v.length > max) throw bad(`${field} must be at most ${max} characters.`);
  return v;
};
const int = (v, { min = -Infinity, max = Infinity, field = 'Field', def } = {}) => {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad(`${field} must be a whole number.`);
  if (n < min || n > max) throw bad(`${field} must be between ${min} and ${max}.`);
  return n;
};
const num = (v, { min = -Infinity, max = Infinity, field = 'Field', def = null } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field} is not valid.`);
  return n;
};
const oneOf = (v, list, field = 'Field') => {
  if (!list.includes(v)) throw bad(`${field} must be one of: ${list.join(', ')}.`);
  return v;
};

module.exports = {
  HttpError, bad, unauthorized, forbidden, notFound,
  Router, parseCookies, readBody, readJson, json, setCookie, rateLimit, clientIp,
  str, int, num, oneOf,
};
