'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('../config');
const { q } = require('../db');
const { bad, notFound, forbidden, readBody, rateLimit } = require('../http');
const { requireAuth } = require('../auth');

/** Detect file type from magic bytes; returns {ext, mime, kind:'image'|'video'|'pdf'} or null. */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', kind: 'image' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', kind: 'image' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', kind: 'image' };
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return { ext: 'mp4', kind: 'video' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', kind: 'video' };
  if (buf.slice(0, 5).toString('ascii') === '%PDF-') return { ext: 'pdf', kind: 'pdf' };
  return null;
}

/** Read pixel dimensions from JPEG / PNG / WebP headers without any dependency. */
function imageSize(buf, ext) {
  try {
    if (ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'jpg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (ext === 'webp') {
      const fmt = buf.slice(12, 16).toString('ascii');
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch { /* fall through */ }
  return { width: 0, height: 0 };
}

const PUBLIC_RE = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|mp4|webm)$/;
const PRIVATE_RE = /^private:[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;

const publicFileExists = (p) => PUBLIC_RE.test(p) && fs.existsSync(path.join(cfg.uploadDir, path.basename(p)));
const privateFileExists = (p) => PRIVATE_RE.test(p) && fs.existsSync(path.join(cfg.privateDir, p.slice(8)));

module.exports = (r) => {
  r.post('/api/upload', requireAuth, async (ctx) => {
    rateLimit(`up:${ctx.user.id}`, 60, 10 * 60_000);
    const kind = ctx.query.get('kind');
    if (!['photo', 'pano', 'video', 'doc', 'avatar'].includes(kind)) throw bad('Unknown upload type.');
    const maxBytes = cfg.limits[kind] * 1024 * 1024;
    const buf = await readBody(ctx.req, maxBytes);
    const type = sniff(buf);
    if (!type) throw bad('Unsupported file. Use JPG, PNG or WebP images, MP4/WebM video, or PDF for documents.');
    if (kind === 'video' && type.kind !== 'video') throw bad('Please upload an MP4 or WebM video.');
    if (['photo', 'pano', 'avatar'].includes(kind) && type.kind !== 'image') throw bad('Please upload a JPG, PNG or WebP image.');
    if (kind === 'doc' && type.kind === 'video') throw bad('Documents must be an image or PDF.');

    const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    const isPrivate = kind === 'doc';
    fs.writeFileSync(path.join(isPrivate ? cfg.privateDir : cfg.uploadDir, name), buf);
    const dims = type.kind === 'image' ? imageSize(buf, type.ext) : { width: 0, height: 0 };
    ctx.status = 201;
    return { path: isPrivate ? `private:${name}` : `/uploads/${name}`, size: buf.length, ...dims };
  });

  // Verification documents are only visible to their owner and admins.
  r.get('/api/private/:file', requireAuth, (ctx) => {
    const file = ctx.params.file;
    if (!/^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(file)) throw notFound();
    const ref = `private:${file}`;
    if (ctx.user.role !== 'admin') {
      const own = q.get('SELECT id FROM verifications WHERE user_id = ? AND (id_doc = ? OR selfie_doc = ? OR ownership_doc = ?)', ctx.user.id, ref, ref, ref);
      if (!own) throw forbidden();
    }
    const full = path.join(cfg.privateDir, file);
    if (!fs.existsSync(full)) throw notFound();
    const ext = path.extname(file).slice(1);
    const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext];
    ctx.raw = { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }, body: fs.readFileSync(full) };
  });
};

module.exports.publicFileExists = publicFileExists;
module.exports.privateFileExists = privateFileExists;
module.exports.imageSize = imageSize;
module.exports.PUBLIC_RE = PUBLIC_RE;
