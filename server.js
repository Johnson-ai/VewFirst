'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./src/config');
require('./src/db');
const { Router, HttpError, readJson, json, clientIp, rateLimit } = require('./src/http');
const { currentUser, ensureAdmin } = require('./src/auth');

const router = new Router();
for (const mod of ['auth', 'uploads', 'listings', 'viewings', 'social', 'admin']) require(`./src/routes/${mod}`)(router);

ensureAdmin();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://aframe.io",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://cdn.aframe.io https://cdnjs.cloudflare.com",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data: https://cdn.aframe.io https://*.tile.openstreetmap.org",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(self), accelerometer=(self), gyroscope=(self), xr-spatial-tracking=(self), camera=(), microphone=()');
}

/** Serve a file from disk with ETag, caching and HTTP Range support (video seeking). */
function serveFile(req, res, file, { immutable = false } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Accept-Ranges': 'bytes',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : stat.size - 1;
    if (!range[1] && range[2]) { start = Math.max(stat.size - Number(range[2]), 0); end = stat.size - 1; }
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true; }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

function safeJoin(base, rel) {
  const full = path.normalize(path.join(base, rel));
  return full.startsWith(base + path.sep) || full === base ? full : null;
}

async function handleApi(req, res, url) {
  const method = req.method;
  const matched = router.match(method, url.pathname);
  if (!matched) {
    if (router.hasPath(url.pathname)) throw new HttpError(405, 'Method not allowed.');
    throw new HttpError(404, 'Not found.');
  }
  rateLimit(`api:${clientIp(req)}`, 600, 60_000);

  const mutating = !['GET', 'HEAD'].includes(method);
  if (mutating) {
    // CSRF defence in depth: SameSite cookies + same-origin check + custom header that browsers will not send cross-site without CORS.
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* invalid */ }
      if (!ok) throw new HttpError(403, 'Cross-site request blocked.');
    }
    if (req.headers['x-requested-with'] !== 'viewfirst') throw new HttpError(403, 'Missing request header.');
  }

  const ctx = {
    req, res, params: matched.params, query: url.searchParams, ip: clientIp(req),
    user: currentUser(req), body: {}, status: 200, raw: null,
  };
  if (mutating && url.pathname !== '/api/upload') ctx.body = await readJson(req);

  let result;
  for (const h of matched.handlers) {
    result = await h(ctx);
    if (ctx.raw || result !== undefined) break;
  }
  if (ctx.raw) { res.writeHead(ctx.raw.status, ctx.raw.headers); return res.end(ctx.raw.body); }
  json(res, ctx.status, result === undefined ? { ok: true } : result);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad URL.'); }

    if (pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');

    if (pathname.startsWith('/uploads/')) {
      const file = safeJoin(cfg.uploadDir, pathname.slice('/uploads/'.length));
      if (file && serveFile(req, res, file, { immutable: true })) return;
      throw new HttpError(404, 'Not found.');
    }

    if (pathname === '/') pathname = '/index.html';
    const file = safeJoin(cfg.publicDir, pathname);
    if (file && serveFile(req, res, file)) return;
    // Unknown non-asset paths fall back to the single-page app.
    if (!path.extname(pathname)) { if (serveFile(req, res, path.join(cfg.publicDir, 'index.html'))) return; }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error('[viewfirst] error', e);
    json(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  }
});

server.requestTimeout = 120_000;
if (require.main === module) {
  server.listen(cfg.port, () => console.log(`[viewfirst] ${cfg.appName} running on http://localhost:${cfg.port}`));
}
module.exports = server;
