#!/usr/bin/env python3
"""
Generates the demo 360° room panoramas (equirectangular) and flat cover photos used by `npm run seed`.
Requires: pip install pillow numpy   (only needed if you want to regenerate; the output is already in public/sample/)

Each room is a box with coloured walls, a patterned floor, windows, a door and a few furniture boxes,
ray-traced per pixel. Not photorealistic, but a genuine 2:1 equirectangular image, so the viewer behaves
exactly as it would with a real 360° photo from a phone or a 360 camera.
"""
import os
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'sample')
os.makedirs(OUT, exist_ok=True)


def hex_rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def hash2(a, b):
    """Cheap deterministic pseudo-random in [0,1) for plank/tile variation."""
    x = np.sin(a * 127.1 + b * 311.7) * 43758.5453
    return x - np.floor(x)


class Room:
    def __init__(self, w, d, h, walls, floor, ceiling='#f4f1ec', floor_kind='planks', windows=(), doors=(), art=(), boxes=(), cam=(0, 0), light=None):
        self.w, self.d, self.h = w, d, h
        self.walls = {k: hex_rgb(v) for k, v in walls.items()}  # keys: px, nx, pz, nz
        self.floor = [hex_rgb(c) for c in (floor if isinstance(floor, (list, tuple)) else [floor])]
        self.ceiling = hex_rgb(ceiling)
        self.floor_kind = floor_kind
        self.windows, self.doors, self.art = windows, doors, art
        self.boxes = [(np.array(mn, dtype=np.float32), np.array(mx, dtype=np.float32), hex_rgb(c)) for mn, mx, c in boxes]
        self.cam = np.array([cam[0], 1.5, cam[1]], dtype=np.float32)
        self.light = np.array(light or [0, h - 0.15, 0], dtype=np.float32)

    # ------------------------------------------------------------------ ray tracing
    def trace(self, dirs):
        n = dirs.shape[0]
        o = self.cam
        hw, hd = self.w / 2, self.d / 2
        planes = [('px', 0, hw, (-1, 0, 0)), ('nx', 0, -hw, (1, 0, 0)), ('pz', 2, hd, (0, 0, -1)), ('nz', 2, -hd, (0, 0, 1)),
                  ('ceil', 1, self.h, (0, -1, 0)), ('floor', 1, 0.0, (0, 1, 0))]
        t_best = np.full(n, np.inf, dtype=np.float32)
        which = np.zeros(n, dtype=np.int8)
        for i, (_, ax, val, _n) in enumerate(planes):
            d = dirs[:, ax]
            with np.errstate(divide='ignore', invalid='ignore'):
                t = (val - o[ax]) / d
            ok = (t > 1e-4) & np.isfinite(t) & (t < t_best)
            t_best = np.where(ok, t, t_best)
            which = np.where(ok, i, which)
        pts = o + dirs * t_best[:, None]
        color = np.zeros((n, 3), dtype=np.float32)
        normal = np.zeros((n, 3), dtype=np.float32)

        for i, (name, ax, val, nrm) in enumerate(planes):
            m = which == i
            if not m.any():
                continue
            p = pts[m]
            normal[m] = nrm
            if name == 'floor':
                color[m] = self.floor_color(p)
            elif name == 'ceil':
                c = np.tile(self.ceiling, (p.shape[0], 1))
                color[m] = c
            else:
                color[m] = self.wall_color(name, p)

        # furniture boxes
        for mn, mx, col in self.boxes:
            with np.errstate(divide='ignore', invalid='ignore'):
                t1 = (mn - o) / dirs
                t2 = (mx - o) / dirs
            tmin = np.minimum(t1, t2)
            tmax = np.maximum(t1, t2)
            tn = np.nanmax(np.where(np.isnan(tmin), -np.inf, tmin), axis=1)
            tf = np.nanmin(np.where(np.isnan(tmax), np.inf, tmax), axis=1)
            hit = (tn < tf) & (tn > 1e-4) & (tn < t_best)
            if not hit.any():
                continue
            axis = np.argmax(np.where(np.isnan(tmin), -np.inf, tmin), axis=1)
            t_best = np.where(hit, tn, t_best)
            nb = np.zeros((n, 3), dtype=np.float32)
            sign = -np.sign(dirs[np.arange(n), axis])
            nb[np.arange(n), axis] = sign
            normal = np.where(hit[:, None], nb, normal)
            shade = np.where(axis == 1, 1.0, np.where(axis == 0, 0.82, 0.9))[:, None]
            color = np.where(hit[:, None], col * shade, color)
            pts = np.where(hit[:, None], o + dirs * t_best[:, None], pts)

        # lighting: ambient + ceiling lamp, plus corner darkening
        lv = self.light - pts
        dist = np.linalg.norm(lv, axis=1) + 1e-6
        diff = np.clip(np.sum(normal * lv / dist[:, None], axis=1), 0, 1)
        bright = 0.68 + 0.5 * diff / (1 + 0.04 * dist ** 2)
        ex = np.minimum(self.w / 2 - np.abs(pts[:, 0]), self.d / 2 - np.abs(pts[:, 2]))
        ey = np.minimum(pts[:, 1], self.h - pts[:, 1])
        ao = 1 - 0.22 * np.exp(-np.minimum(ex, ey) / 0.28)
        out = color * (bright * ao)[:, None]
        return np.clip(out, 0, 1)

    def floor_color(self, p):
        x, z = p[:, 0], p[:, 2]
        if self.floor_kind == 'tiles':
            s = 0.6
            ix, iz = np.floor(x / s), np.floor(z / s)
            fx, fz = x / s - ix, z / s - iz
            grout = (fx < 0.03) | (fz < 0.03)
            base = self.floor[0] if len(self.floor) == 1 else np.where(((ix + iz) % 2 == 0)[:, None], self.floor[0], self.floor[1])
            tint = (0.94 + 0.06 * hash2(ix, iz))[:, None]
            c = base * tint
            return np.where(grout[:, None], np.array([0.78, 0.78, 0.76], dtype=np.float32), c)
        # planks along z
        pw = 0.18
        ip = np.floor(x / pw)
        fx = x / pw - ip
        seam = np.floor(z / 1.2 + hash2(ip, 3.0) * 3)
        tint = (0.84 + 0.2 * hash2(ip, seam))[:, None]
        grain = (0.97 + 0.03 * np.sin(z * 40 + ip * 5))[:, None]
        c = self.floor[0] * tint * grain
        return np.where((fx < 0.04)[:, None], c * 0.72, c)

    def wall_color(self, name, p):
        c = np.tile(self.walls[name], (p.shape[0], 1))
        # (u along the wall, v up)
        u = p[:, 2] if name in ('px', 'nx') else p[:, 0]
        v = p[:, 1]
        # baseboard
        c = np.where((v < 0.1)[:, None], np.array([0.96, 0.95, 0.93], dtype=np.float32) * 0.92, c)
        c = np.where(((v > self.h - 0.06))[:, None], self.ceiling * 0.97, c)
        for (wn, uc, ww, vb, vh) in self.windows:
            if wn != name:
                continue
            inside = (np.abs(u - uc) < ww / 2) & (v > vb) & (v < vb + vh)
            frame = inside & ((np.abs(u - uc) > ww / 2 - 0.06) | (v < vb + 0.06) | (v > vb + vh - 0.06))
            mull = inside & ((np.abs(u - uc) < 0.025) | (np.abs(v - (vb + vh / 2)) < 0.02))
            k = np.clip((v - vb) / vh, 0, 1)[:, None]
            sky = (1 - k) * np.array([0.92, 0.96, 1.0], dtype=np.float32) + k * np.array([0.52, 0.74, 0.96], dtype=np.float32)
            c = np.where(inside[:, None], sky * 1.15, c)
            c = np.where((frame | mull)[:, None], np.array([0.97, 0.97, 0.96], dtype=np.float32), c)
            glow = (np.abs(u - uc) < ww / 2 + 0.25) & (v > vb - 0.1) & (v < vb + vh + 0.2) & ~inside
            c = np.where(glow[:, None], np.minimum(c * 1.06 + 0.02, 1), c)
        for (wn, uc, dw, dh, col) in self.doors:
            if wn != name:
                continue
            inside = (np.abs(u - uc) < dw / 2) & (v < dh)
            panel = inside & (np.abs(u - uc) < dw / 2 - 0.12) & (v > 0.18) & (v < dh - 0.12)
            dc = hex_rgb(col)
            c = np.where(inside[:, None], dc * 0.9, c)
            c = np.where(panel[:, None], dc * 1.08, c)
            knob = (np.abs(u - (uc + dw / 2 - 0.12)) < 0.03) & (np.abs(v - 1.0) < 0.03)
            c = np.where(knob[:, None], np.array([0.85, 0.75, 0.4], dtype=np.float32), c)
        for (wn, uc, aw, ah, vc, col) in self.art:
            if wn != name:
                continue
            inside = (np.abs(u - uc) < aw / 2) & (np.abs(v - vc) < ah / 2)
            border = inside & ((np.abs(u - uc) > aw / 2 - 0.035) | (np.abs(v - vc) > ah / 2 - 0.035))
            c = np.where(inside[:, None], hex_rgb(col), c)
            c = np.where(border[:, None], np.array([0.2, 0.18, 0.16], dtype=np.float32), c)
        return c


def equirect(room, w=2560):
    h = w // 2
    lon = (np.arange(w, dtype=np.float32) + 0.5) / w * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(h, dtype=np.float32) + 0.5) / h * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    d = np.stack([np.cos(LAT) * np.sin(LON), np.sin(LAT), np.cos(LAT) * np.cos(LON)], axis=-1).reshape(-1, 3)
    img = room.trace(d).reshape(h, w, 3)
    return Image.fromarray((img * 255).astype(np.uint8))


def perspective(room, yaw_deg, w=1400, h=933, fov=78, pitch_deg=0, cam=None):
    if cam is not None:
        room.cam = np.array([cam[0], 1.45, cam[1]], dtype=np.float32)
    yaw, pitch = np.radians(yaw_deg), np.radians(pitch_deg)
    f = 0.5 * w / np.tan(np.radians(fov) / 2)
    xs = (np.arange(w, dtype=np.float32) + 0.5 - w / 2) / f
    ys = -(np.arange(h, dtype=np.float32) + 0.5 - h / 2) / f
    X, Y = np.meshgrid(xs, ys)
    d = np.stack([X, Y, np.ones_like(X)], axis=-1)
    cp, sp, cy, sy = np.cos(pitch), np.sin(pitch), np.cos(yaw), np.sin(yaw)
    y1 = d[..., 1] * cp - d[..., 2] * sp
    z1 = d[..., 1] * sp + d[..., 2] * cp
    x2 = d[..., 0] * cy + z1 * sy
    z2 = -d[..., 0] * sy + z1 * cy
    dirs = np.stack([x2, y1, z2], axis=-1).reshape(-1, 3)
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    img = room.trace(dirs).reshape(h, w, 3)
    return Image.fromarray((img * 255).astype(np.uint8))


def save(img, name, q=80):
    path = os.path.join(OUT, name)
    img.save(path, 'JPEG', quality=q, optimize=True, progressive=True)
    print(f'{name}: {img.size[0]}x{img.size[1]}  {os.path.getsize(path) // 1024} KB')


# ---------------------------------------------------------------------------------- room definitions
def living(pal):
    wall, accent, floor, sofa, rug = pal
    return Room(
        5.6, 4.6, 2.8, {'px': wall, 'nx': wall, 'pz': accent, 'nz': wall}, floor,
        windows=[('px', -0.6, 2.2, 0.85, 1.45), ('nx', 0.4, 1.6, 0.9, 1.4)],
        doors=[('nz', -1.4, 0.95, 2.05, '#7a5a3c')],
        art=[('pz', 0.0, 1.2, 0.8, 1.7, '#c9a27a'), ('pz', 1.5, 0.5, 0.65, 1.7, '#5b7c8d')],
        boxes=[((-2.6, 0, 0.7), (-0.9, 0.42, 1.9), sofa),               # sofa seat
               ((-2.7, 0.42, 0.7), (-2.35, 0.9, 1.9), sofa),            # sofa back
               ((-2.6, 0.42, 0.7), (-0.9, 0.62, 0.9), sofa),            # arm
               ((-0.4, 0, 0.9), (0.7, 0.4, 1.6), '#8b6b4a'),            # coffee table
               ((1.0, 0, 2.0), (2.6, 0.55, 2.35), '#3b3b3f'),           # tv console
               ((1.3, 0.55, 2.15), (2.3, 1.2, 2.2), '#101214'),         # tv
               ((-0.6, 0.005, 0.5), (0.9, 0.012, 1.9), rug)],
        cam=(0.3, -0.5))


def bedroom(pal):
    wall, accent, floor, bed, _ = pal
    return Room(
        4.2, 3.8, 2.7, {'px': wall, 'nx': accent, 'pz': wall, 'nz': wall}, floor,
        windows=[('pz', 0.2, 1.8, 0.9, 1.4)],
        doors=[('nz', 1.2, 0.9, 2.05, '#7a5a3c')],
        art=[('nx', 0.0, 0.9, 0.6, 1.6, '#d8c3a5')],
        boxes=[((-1.9, 0, -0.4), (-0.1, 0.45, 1.7), '#e9e6df'),         # mattress
               ((-1.9, 0.45, -0.4), (-0.1, 0.55, 1.7), bed),             # duvet
               ((-2.0, 0, -0.5), (-1.9, 1.15, 1.8), '#6d5a47'),          # headboard
               ((-1.9, 0, -0.95), (-1.5, 0.5, -0.5), '#6d5a47'),         # bedside
               ((1.1, 0, -1.8), (2.0, 2.2, 0.3), '#8a6f52'),             # wardrobe
               ((-0.9, 0.005, 0.2), (0.9, 0.012, 1.6), '#d6cfc3')],
        cam=(0.2, 0.2))


def kitchen(pal):
    wall, accent, _floor, cab, _ = pal
    return Room(
        3.8, 3.2, 2.7, {'px': wall, 'nx': wall, 'pz': wall, 'nz': accent}, ['#d9d6cf', '#cbc8c0'], floor_kind='tiles',
        windows=[('pz', 0.0, 1.4, 1.1, 1.1)],
        doors=[('nx', 0.5, 0.9, 2.05, '#7a5a3c')],
        boxes=[((-1.9, 0, 0.5), (-1.25, 0.9, 1.6), cab), ((-1.9, 0, -1.6), (-1.25, 0.9, 0.5), cab),
               ((-1.9, 0.9, -1.6), (-1.25, 0.95, 1.6), '#2c2f33'),      # worktop
               ((-1.9, 1.5, -1.6), (-1.55, 2.2, 1.6), cab),             # wall cabinets
               ((-1.7, 0.95, 0.9), (-1.35, 1.0, 1.3), '#b9bdc2'),       # hob
               ((1.0, 0, -1.6), (1.9, 1.85, -0.95), '#c9ccd1'),         # fridge
               ((0.1, 0, 0.0), (0.9, 0.78, 0.8), '#8b6b4a')],           # small table
        cam=(0.3, 0.0))


def bathroom(pal):
    wall, accent, _f, _c, _ = pal
    return Room(
        2.6, 2.4, 2.6, {'px': wall, 'nx': wall, 'pz': accent, 'nz': wall}, ['#e4e2dd', '#d3d1cb'], floor_kind='tiles',
        windows=[('px', -0.2, 0.7, 1.4, 0.6)],
        doors=[('nz', 0.3, 0.8, 2.05, '#7a5a3c')],
        boxes=[((-1.3, 0, 0.1), (-0.55, 0.55, 1.2), '#f6f6f4'),         # tub/shower tray
               ((0.3, 0, 0.9), (0.85, 0.42, 1.2), '#f6f6f4'),           # wc base
               ((0.35, 0.42, 1.08), (0.8, 0.95, 1.2), '#f6f6f4'),       # cistern
               ((-0.5, 0.78, -1.2), (0.3, 0.86, -0.75), '#f6f6f4'),     # basin
               ((-0.5, 0, -1.15), (0.3, 0.78, -0.8), '#8b6b4a')],
        cam=(0.1, -0.1))


PALETTES = {
    'a': ('#e8e2d6', '#b7c4b0', ['#a67c52'], '#5f7a8a', '#cbbfa8'),
    'b': ('#eef0f2', '#d9a79b', ['#8d6b4a'], '#a45d4f', '#b5c4cf'),
    'c': ('#f0ebe3', '#93a8b8', ['#c9a67a'], '#3f5568', '#d8d0c0'),
}

if __name__ == '__main__':
    for key, pal in PALETTES.items():
        save(equirect(living(pal)), f'pano_living_{key}.jpg')
        save(equirect(bedroom(pal)), f'pano_bedroom_{key}.jpg')
        save(perspective(living(pal), -38, fov=88, pitch_deg=7, cam=(2.45, -1.95)), f'photo_living_{key}.jpg', 82)
        save(perspective(bedroom(pal), -32, fov=88, pitch_deg=7, cam=(0.7, -1.7)), f'photo_bedroom_{key}.jpg', 82)
    pal = PALETTES['a']
    save(equirect(kitchen(pal)), 'pano_kitchen.jpg')
    save(equirect(bathroom(pal)), 'pano_bathroom.jpg')
    save(perspective(kitchen(pal), -116, fov=90, pitch_deg=7, cam=(1.3, 1.2)), 'photo_kitchen.jpg', 82)
    save(perspective(bathroom(pal), -59, fov=92, pitch_deg=7, cam=(1.0, -0.2)), 'photo_bathroom.jpg', 82)
