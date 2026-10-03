import { h, clear, icon, state, post, loadScript, loadCss, plural } from './lib.js';

const PANNELLUM_JS = 'https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.js';
const PANNELLUM_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/pannellum.css';
const AFRAME_JS = 'https://aframe.io/releases/1.5.0/aframe.min.js';

/** Convert stored pixel dimensions into Pannellum field-of-view settings (handles partial panoramas). */
export function sceneConfig(room) {
  const ratio = room.pano_w && room.pano_h ? room.pano_w / room.pano_h : 2;
  const vaov = Math.min(180, 360 / ratio);
  const cfg = { type: 'equirectangular', panorama: room.panorama, haov: 360, vaov, vOffset: 0, hfov: 100, autoLoad: true };
  if (vaov < 180) { cfg.minPitch = -vaov / 2; cfg.maxPitch = vaov / 2; }
  return cfg;
}

export async function ensurePannellum() {
  loadCss(PANNELLUM_CSS);
  if (!window.pannellum) await loadScript(PANNELLUM_JS);
}

/**
 * Builds the tour component.
 * listing: API listing object (rooms, video, tour_seen, ...)
 * onProgress(complete:boolean): called whenever the seen-set changes
 */
export function buildTour(listing, onProgress) {
  const rooms = listing.rooms;
  const seen = new Set(listing.tour_seen || []);
  const required = rooms.length ? rooms.map((r) => r.id) : (listing.video ? [0] : []);
  let current = null; let viewer = null; let dwell = null; let mode = rooms.length ? 'pano' : 'video';

  const stage = h('div', { class: 'tour-stage' });
  const roomBar = h('div', { class: 'tour-rooms', role: 'tablist', 'aria-label': 'Rooms' });
  const progress = h('div', { class: 'tour-progress' });
  const root = h('section', { class: 'tour', 'aria-label': 'Virtual tour' }, stage, roomBar, progress);

  const complete = () => required.every((id) => seen.has(id));

  function drawProgress() {
    const done = required.filter((id) => seen.has(id)).length;
    clear(progress).append(
      h('span', null, required.length ? [h('b', null, `${done} of ${required.length}`), ` ${rooms.length ? 'rooms' : 'video'} viewed`] : 'No tour available yet'),
      h('span', null, complete() ? 'Tour complete. You can now request a viewing.' : 'View every room to unlock viewing requests.'));
  }

  function track(id) {
    if (seen.has(id)) return;
    clearTimeout(dwell);
    // Count a room as seen after 2.5 seconds, so skimming past does not unlock booking.
    dwell = setTimeout(async () => {
      seen.add(id); drawBar(); drawProgress();
      if (state.user) {
        try { const r = await post(`/api/listings/${listing.id}/tour-progress`, { room_id: id }); (r.seen || []).forEach((x) => seen.add(x)); drawBar(); drawProgress(); } catch { /* retry on next visit */ }
      }
      onProgress?.(complete());
    }, 2500);
  }

  function drawBar() {
    clear(roomBar);
    rooms.forEach((r) => {
      const on = mode === 'pano' && current === r.id;
      roomBar.append(h('button', { class: `tour-room ${on ? 'on' : ''}`, role: 'tab', 'aria-selected': on, onclick: () => showRoom(r.id) },
        h('span', { class: `tick ${seen.has(r.id) ? 'seen' : ''}` }, seen.has(r.id) ? icon('check', 10) : null), r.name));
    });
    if (listing.video) {
      const on = mode === 'video';
      roomBar.append(h('button', { class: `tour-room ${on ? 'on' : ''}`, role: 'tab', 'aria-selected': on, onclick: showVideo },
        h('span', { class: `tick ${seen.has(0) && !rooms.length ? 'seen' : ''}` }, seen.has(0) && !rooms.length ? icon('check', 10) : null), icon('play', 12), 'Video walkthrough'));
    }
  }

  function destroyViewer() { try { viewer?.destroy(); } catch { /* ignore */ } viewer = null; clear(stage); }

  async function showRoom(id) {
    mode = 'pano'; current = id;
    const room = rooms.find((r) => r.id === id);
    drawBar();
    destroyViewer();
    const msg = h('div', { class: 'tour-msg' }, 'Loading 360° view…');
    stage.append(msg);
    try {
      await ensurePannellum();
      clear(stage);
      const holder = h('div', { style: { position: 'absolute', inset: 0 } });
      stage.append(holder);
      viewer = window.pannellum.viewer(holder, { ...sceneConfig(room), autoRotate: -2, autoRotateInactivityDelay: 3000, showFullscreenCtrl: true, showZoomCtrl: true, mouseZoom: true, compass: false, orientationOnByDefault: false });
      viewer.on?.('load', () => { clearTimeout(dwell); track(id); });
      stage.append(h('div', { class: 'tour-tools' },
        h('button', { class: 'btn btn-sm', onclick: () => openVR(room), title: 'Open in VR / headset mode' }, icon('vr', 16), 'VR mode')));
      track(id);
    } catch {
      clear(stage).append(h('img', { src: room.panorama, alt: room.name, style: { objectFit: 'contain' } }),
        h('div', { class: 'tour-tools' }, h('span', { class: 'chip' }, 'Interactive viewer unavailable offline')));
      track(id);
    }
  }

  function showVideo() {
    mode = 'video'; current = null; drawBar(); destroyViewer();
    const v = h('video', { src: listing.video, controls: true, playsinline: true, preload: 'metadata', 'aria-label': 'Video walkthrough' });
    v.addEventListener('timeupdate', () => { if (!rooms.length && v.currentTime > 5) track(0); });
    v.addEventListener('ended', () => { if (!rooms.length) { seen.add(0); track(0); } });
    if (rooms.length) v.addEventListener('play', () => { /* video is optional when 360 rooms exist */ });
    stage.append(v);
  }

  // ---------------------------------------------------------------- VR mode (A-Frame, lazy loaded)
  async function openVR(startRoom) {
    const overlay = h('div', { class: 'vr-overlay' }, h('div', { class: 'tour-msg' }, 'Loading VR…'));
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    try { await loadScript(AFRAME_JS); } catch {
      clear(overlay).append(h('div', { class: 'tour-msg' }, h('div', null, h('p', null, 'VR mode needs an internet connection to load its viewer.'), h('button', { class: 'btn', onclick: close }, 'Close'))));
      return;
    }
    clear(overlay);
    const scene = document.createElement('a-scene');
    scene.setAttribute('embedded', ''); scene.setAttribute('vr-mode-ui', 'enabled: true'); scene.setAttribute('loading-screen', 'enabled: false');
    const sky = document.createElement('a-sky'); sky.setAttribute('src', startRoom.panorama); sky.setAttribute('rotation', '0 -90 0');
    const cam = document.createElement('a-entity'); cam.setAttribute('camera', ''); cam.setAttribute('look-controls', 'reverseMouseDrag: true');
    cam.setAttribute('position', '0 1.6 0');
    const cursor = document.createElement('a-entity');
    cursor.setAttribute('cursor', 'fuse: true; fuseTimeout: 1400; rayOrigin: mouse'); cursor.setAttribute('position', '0 0 -1');
    cursor.setAttribute('geometry', 'primitive: ring; radiusInner: 0.012; radiusOuter: 0.02'); cursor.setAttribute('material', 'color: white; shader: flat');
    cursor.setAttribute('raycaster', 'objects: .hot');
    cam.appendChild(cursor); scene.append(sky, cam);

    const label = h('div', { class: 'vr-label' }, startRoom.name);
    // Room hotspots: floating labels in a ring around the viewer (look at one to hop to that room).
    rooms.forEach((r, i) => {
      const ang = (i / rooms.length) * Math.PI * 2;
      const x = Math.sin(ang) * 3.2; const z = -Math.cos(ang) * 3.2;
      const hot = document.createElement('a-entity');
      hot.setAttribute('class', 'hot'); hot.setAttribute('position', `${x} 0.9 ${z}`);
      hot.setAttribute('look-at', '[camera]');
      hot.setAttribute('geometry', 'primitive: plane; width: 1.5; height: 0.4');
      hot.setAttribute('material', 'color: #2147d0; opacity: 0.9; shader: flat');
      hot.setAttribute('text', `value: ${r.name.replace(/[^\w\s.-]/g, '')}; align: center; width: 2.4; color: white`);
      hot.addEventListener('click', () => { sky.setAttribute('src', r.panorama); label.textContent = r.name; });
      scene.appendChild(hot);
    });
    overlay.append(scene, label, h('button', { class: 'btn vr-close', onclick: close }, icon('close', 16), 'Exit VR'));
  }

  drawProgress();
  drawBar();
  if (rooms.length) showRoom(rooms[0].id);
  else if (listing.video) showVideo();
  else stage.append(h('div', { class: 'tour-msg' }, 'The landlord has not added a virtual tour yet.'));

  return { el: root, isComplete: complete, destroy: () => { clearTimeout(dwell); destroyViewer(); } };
}

/** Auto-rotating hero preview, falls back to the still image when the viewer cannot load. */
export async function heroPano(container, src, caption) {
  container.append(h('img', { class: 'fallback', src: src.replace('/pano_', '/photo_').replace('living_a', 'living_b'), alt: 'Sample living room' }));
  try {
    await ensurePannellum();
    clear(container);
    const holder = h('div', { style: { position: 'absolute', inset: 0 } });
    container.append(holder);
    window.pannellum.viewer(holder, { type: 'equirectangular', panorama: src, autoLoad: true, autoRotate: -4, showControls: false, hfov: 105, pitch: -4, mouseZoom: false, compass: false });
  } catch { /* still image remains */ }
  container.append(h('div', { class: 'pano-caption' }, icon('vr', 14), caption));
}

export { plural };
