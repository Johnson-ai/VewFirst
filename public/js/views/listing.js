import {
  h, clear, state, get, post, del, icon, toast, fail, modal, confirmDialog, field, money, priceLabel, dateTime, dateOnly, timeAgo,
  plural, cap, stars, starInput, avatar, verifiedBadge, copyText, emptyState,
} from '../lib.js';
import { buildTour } from '../tour.js';
import { ensureLeaflet } from './search.js';

const REPORT_REASONS = [['scam', 'Looks like a scam'], ['fake_listing', 'Fake or already rented'], ['misleading', 'Photos or details are misleading'], ['abusive', 'Abusive or offensive'], ['spam', 'Spam'], ['other', 'Something else']];

export function reportDialog(targetType, targetId) {
  if (!state.user) { toast('Log in to report'); location.hash = '/login'; return; }
  modal('Report to moderators', (body, close) => {
    const reason = h('select', null, REPORT_REASONS.map(([v, l]) => h('option', { value: v }, l)));
    const details = h('textarea', { maxlength: 800, placeholder: 'What should we look at?' });
    const err = h('div', { class: 'form-error', hidden: true });
    body.append(err, field('Reason', reason), field('Details (optional)', details),
      h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: async () => {
          try { await post('/api/reports', { target_type: targetType, target_id: targetId, reason: reason.value, details: details.value }); toast('Thanks. Moderators will review this.', 'success'); close(); }
          catch (e) { err.textContent = e.message; err.hidden = false; }
        } }, 'Send report')));
  });
}

export default async function listingView(root, [id]) {
  let L;
  try { L = await get(`/api/listings/${id}`); } catch (e) {
    root.append(h('div', { class: 'wrap page' }, emptyState('Listing not found', 'It may have been rented or removed.', h('a', { class: 'btn btn-primary', href: '#/search' }, 'Find another place')))); return;
  }
  document.title = `${L.title} · ${state.meta.appName}`;
  const me = state.user;
  let tour = null; let miniMap = null;
  const loggedIn = !!me;

  // ------------------------------------------------------------------ owner bar
  if (L.is_owner) {
    root.append(h('div', { class: 'owner-bar' }, h('div', { class: 'wrap row between wrap-row gap' },
      h('span', null, `This is your listing. Status: `, h('strong', null, L.status), L.views != null ? ` · ${plural(L.views, 'view')}` : ''),
      h('div', { class: 'row gap-s' }, h('a', { class: 'btn btn-sm', href: `#/listing/${L.id}/edit` }, icon('edit', 14), 'Edit'), h('a', { class: 'btn btn-sm', href: '#/dashboard' }, 'Dashboard')))));
  }

  // ------------------------------------------------------------------ booking / contact panel
  const side = h('aside', { class: 'side' });
  const sidePanel = h('div', { class: 'panel' });
  side.append(sidePanel);

  function costRows() {
    const rows = [[`Rent (${L.period === 'month' ? 'per month' : 'per year'})`, L.price]];
    if (L.deposit) rows.push(['Refundable deposit', L.deposit]);
    if (L.service_charge) rows.push(['Service charge', L.service_charge]);
    const total = rows.reduce((s, r) => s + r[1], 0);
    return h('table', { class: 'cost-table', 'aria-label': 'Move-in cost' }, h('tbody', null,
      rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, money(v)))),
      h('tr', { class: 'total' }, h('td', null, 'To move in'), h('td', null, money(total)))));
  }

  function drawSide() {
    clear(sidePanel);
    const canBook = L.status === 'published' && !L.is_owner;
    sidePanel.append(
      h('div', { class: 'side-price' }, money(L.price), h('small', { class: 'muted', style: { fontSize: '1rem', fontWeight: 400 } }, ` / ${L.period === 'month' ? 'month' : 'year'}`)),
      costRows(),
      L.status === 'rented' ? h('div', { class: 'notice' }, 'This place has been rented.') : null);

    if (canBook) {
      const complete = !!L.tour_complete;
      const hasTour = (L.rooms.length || L.video);
      const v = L.my_viewing;
      if (v) {
        sidePanel.append(h('div', { class: 'gate ok' }, h('strong', null, v.status === 'requested' ? 'Viewing requested' : 'Viewing confirmed'), h('div', null, dateTime(v.starts_at)),
          v.status === 'confirmed' ? h('div', { class: 'small' }, 'The exact address is shown below.') : h('div', { class: 'small' }, 'Waiting for the landlord to confirm.')),
          h('a', { class: 'btn btn-block', href: '#/viewings' }, 'Manage viewing'));
      } else {
        if (!loggedIn) sidePanel.append(h('div', { class: 'gate' }, 'Log in, tour the place, then request a viewing.'));
        else if (!hasTour) sidePanel.append(h('div', { class: 'gate' }, 'This listing has no virtual tour yet. Message the landlord to ask for one.'));
        else if (!complete) {
          const done = L.tour_required.filter((x) => L.tour_seen.includes(x)).length;
          sidePanel.append(h('div', { class: 'gate' }, h('strong', null, 'Finish the tour to book a viewing'), h('div', { class: 'small' }, `${done} of ${L.tour_required.length} viewed. This saves you a trip to a place you already know you dislike.`)));
        } else sidePanel.append(h('div', { class: 'gate ok' }, 'You have toured every room. You can request a viewing.'));
        sidePanel.append(h('button', { class: 'btn btn-primary btn-block btn-lg', 'aria-disabled': loggedIn && hasTour && !complete ? 'true' : 'false', onclick: () => {
          if (!loggedIn) { location.hash = '/login'; return; }
          if (!hasTour) return toast('No tour yet. Message the landlord instead.');
          if (!complete) return toast('View every room in the tour first.', 'error');
          bookDialog();
        } }, icon('calendar', 18), 'Request a viewing'));
      }
      sidePanel.append(h('button', { class: 'btn btn-block', style: { marginTop: '.6rem' }, onclick: contact }, icon('chat', 16), L.my_conversation ? 'Open conversation' : 'Message the landlord'));
    }
    sidePanel.append(h('div', { class: 'row gap-s', style: { marginTop: '.8rem' } },
      h('button', { class: `btn btn-sm ${L.favorited ? 'btn-primary' : ''}`, onclick: toggleFav }, icon('heart', 15), L.favorited ? 'Saved' : 'Save'),
      h('button', { class: 'btn btn-sm', onclick: () => copyText(location.href) }, icon('share', 15), 'Share'),
      !L.is_owner ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => reportDialog('listing', L.id) }, icon('flag', 15), 'Report') : null));

    // landlord card
    const o = L.owner;
    clear(landlordPanel).append(
      h('div', { class: 'landlord-card' }, avatar(o, 48),
        h('div', { class: 'grow' }, h('a', { href: `#/landlord/${o.id}`, style: { fontWeight: 600 } }, o.name),
          h('div', { class: 'small muted' }, `On the platform since ${dateOnly(o.since)}`),
          h('div', { class: 'row gap-s', style: { marginTop: '.25rem' } }, o.verified ? verifiedBadge() : h('span', { class: 'chip chip-warn' }, 'Identity not yet verified'),
            o.rating_count ? h('span', { class: 'row gap-s small' }, stars(o.rating, 13), `${o.rating} (${o.rating_count})`) : null))),
      !o.verified ? h('p', { class: 'small muted', style: { margin: '.7rem 0 0' } }, 'Be extra careful: never pay before seeing the place and meeting the landlord.') : null);
  }
  const landlordPanel = h('div', { class: 'panel' });
  side.append(landlordPanel);
  side.append(h('div', { class: 'panel notice' }, h('strong', null, 'Stay safe. '), 'Pay only after you have visited, met the landlord and seen proof of ownership. This platform never asks you for money.'));

  async function toggleFav() {
    if (!loggedIn) { location.hash = '/login'; return; }
    try { if (L.favorited) await del(`/api/listings/${L.id}/favorite`); else await post(`/api/listings/${L.id}/favorite`); L.favorited = !L.favorited; drawSide(); } catch (e) { fail(e); }
  }

  async function contact() {
    if (!loggedIn) { location.hash = '/login'; return; }
    if (L.my_conversation) { location.hash = `/messages/${L.my_conversation}`; return; }
    modal('Message the landlord', (body, close) => {
      const msg = h('textarea', { maxlength: 2000, placeholder: 'Hello, is this still available? When can I tour the rest of the building?' });
      const err = h('div', { class: 'form-error', hidden: true });
      body.append(err, field('Your message', msg), h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: async () => {
          try { const r = await post('/api/conversations', { listing_id: L.id, body: msg.value }); close(); location.hash = `/messages/${r.id}`; }
          catch (e) { err.textContent = e.message; err.hidden = false; }
        } }, 'Send')));
    });
  }

  async function bookDialog() {
    modal('Choose a viewing time', async (body, close) => {
      body.append(h('div', { class: 'skeleton', style: { height: '8rem' } }));
      let slots;
      try { slots = (await get(`/api/listings/${L.id}/slots`)).slots; } catch (e) { clear(body).append(h('div', { class: 'form-error' }, e.message)); return; }
      clear(body);
      if (!slots.length) { body.append(h('p', null, 'The landlord has not published open times yet. Send a message to ask for one.'), h('button', { class: 'btn btn-primary', onclick: () => { close(); contact(); } }, 'Message the landlord')); return; }
      let chosen = null;
      const byDay = {};
      for (const s of slots) { const day = new Date(s.starts_at).toDateString(); (byDay[day] ||= []).push(s); }
      const list = h('div', { class: 'stack' });
      const btns = [];
      for (const [day, arr] of Object.entries(byDay)) {
        list.append(h('div', null, h('strong', null, day), h('div', { class: 'row wrap-row gap-s', style: { marginTop: '.4rem' } }, arr.map((s) => {
          const b = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { chosen = s.id; btns.forEach((x) => x.classList.remove('btn-primary')); b.classList.add('btn-primary'); } },
            new Date(s.starts_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
          btns.push(b); return b;
        }))));
      }
      const note = h('textarea', { maxlength: 400, style: { minHeight: '70px' }, placeholder: 'Anything the landlord should know? (optional)' });
      const err = h('div', { class: 'form-error', hidden: true });
      body.append(err, list, h('div', { style: { marginTop: '1rem' } }, field('Note to landlord', note)),
        h('p', { class: 'small muted' }, 'Times are shown in your local timezone. The landlord confirms the request, then the exact address and phone numbers are shared.'),
        h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', { class: 'btn btn-primary', onclick: async () => {
            if (!chosen) { err.textContent = 'Pick a time first.'; err.hidden = false; return; }
            try { await post(`/api/listings/${L.id}/viewings`, { slot_id: chosen, note: note.value }); close(); toast('Viewing requested. We will notify you when the landlord replies.', 'success'); L = await get(`/api/listings/${L.id}`); drawSide(); }
            catch (e) { err.textContent = e.message; err.hidden = false; }
          } }, 'Send request')));
    });
  }

  // ------------------------------------------------------------------ main column
  const tourHost = h('div');
  if (L.rooms.length || L.video) {
    tour = buildTour(L, async (complete) => {
      if (complete && loggedIn) { try { const fresh = await get(`/api/listings/${L.id}`); L = { ...L, tour_seen: fresh.tour_seen, tour_complete: fresh.tour_complete }; } catch { /* keep */ } }
      else if (loggedIn) { try { const fresh = await get(`/api/listings/${L.id}`); L.tour_seen = fresh.tour_seen; L.tour_complete = fresh.tour_complete; } catch { /* keep */ } }
      drawSide();
    });
    tourHost.append(tour.el);
    if (!loggedIn) tourHost.append(h('p', { class: 'small muted', style: { margin: '.5rem 0 0' } }, h('a', { href: '#/login' }, 'Log in'), ' to have your tour progress saved and unlock viewing requests.'));
  } else tourHost.append(h('div', { class: 'tour' }, h('div', { class: 'tour-stage' }, h('div', { class: 'tour-msg' }, 'No virtual tour yet.'))));

  const gallery = L.photos.length ? h('div', { class: 'gallery', 'aria-label': 'Photos' }, L.photos.map((p, i) => h('button', { 'aria-label': `Open photo ${i + 1}`, onclick: () => lightbox(i) }, h('img', { src: p.path, alt: '', loading: 'lazy' })))) : null;

  function lightbox(start) {
    let i = start;
    const img = h('img', { src: L.photos[i].path, alt: `Photo ${i + 1} of ${L.photos.length}` });
    const step = (d) => { i = (i + d + L.photos.length) % L.photos.length; img.src = L.photos[i].path; img.alt = `Photo ${i + 1} of ${L.photos.length}`; };
    const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === box) close(); } },
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 26)),
      L.photos.length > 1 ? [h('button', { class: 'icon-btn nav-l', 'aria-label': 'Previous', onclick: () => step(-1) }, icon('left', 30)), h('button', { class: 'icon-btn nav-r', 'aria-label': 'Next', onclick: () => step(1) }, icon('right', 30))] : null, img);
    document.body.appendChild(box); document.addEventListener('keydown', onKey);
  }

  const facts = h('div', { class: 'facts' },
    h('div', { class: 'fact' }, h('b', null, L.beds === 0 ? 'Studio' : L.beds), h('span', null, L.beds === 0 ? 'Layout' : plural(L.beds, 'bedroom').replace(/^\d+ /, ''))),
    h('div', { class: 'fact' }, h('b', null, L.baths), h('span', null, L.baths === 1 ? 'bathroom' : 'bathrooms')),
    L.size_sqm ? h('div', { class: 'fact' }, h('b', null, `${L.size_sqm} m²`), h('span', null, 'floor area')) : null,
    h('div', { class: 'fact' }, h('b', null, cap(L.type)), h('span', null, L.furnished ? 'furnished' : 'unfurnished')),
    h('div', { class: 'fact' }, h('b', null, `${L.min_lease_months} mo`), h('span', null, 'minimum lease')),
    L.available_from ? h('div', { class: 'fact' }, h('b', null, dateOnly(L.available_from)), h('span', null, 'available from')) : null);

  const mapBox = h('div', { class: 'mini-map' });
  const locationSection = h('section', { style: { marginTop: '2rem' } }, h('h2', null, 'Location'),
    L.exact_location ? h('p', null, h('strong', null, L.address), `, ${L.area}, ${L.city}`) : h('p', { class: 'muted' }, `${L.area}, ${L.city}. The exact address and pin are shared once the landlord confirms your viewing.`), mapBox);

  // ---------------------------------------------------------------- reviews
  const reviewsHost = h('section', { id: 'reviews', style: { marginTop: '2.5rem' } });
  async function drawReviews() {
    const R = await get(`/api/listings/${L.id}/reviews`);
    clear(reviewsHost);
    const total = R.distribution.reduce((a, b) => a + b, 0);
    reviewsHost.append(h('h2', null, 'Reviews'));
    reviewsHost.append(h('div', { class: 'rating-summary' },
      h('div', null, h('div', { class: 'rating-big' }, L.avg_property ? L.avg_property : '–'), stars(L.avg_property, 18), h('div', { class: 'small muted' }, plural(L.n_property, 'rating'))),
      h('div', { class: 'bars' }, [5, 4, 3, 2, 1].map((n) => h('div', { class: 'bar' }, h('span', null, n), h('i', null, h('b', { style: { width: total ? `${(R.distribution[n - 1] / total) * 100}%` : '0' } })), h('span', null, R.distribution[n - 1]))))));
    const mine = R.items.find((r) => me && r.author_id === me.id);
    if (R.can_review) reviewsHost.append(reviewForm(mine));
    else if (R.reason) reviewsHost.append(h('p', { class: 'muted small' }, R.reason));
    if (!R.items.length) reviewsHost.append(h('p', { class: 'muted' }, 'No reviews yet. People who view the place can be the first to share what it is really like.'));
    for (const r of R.items) {
      const replyBtn = L.is_owner && me?.id === L.owner_id && !r.reply ? h('button', { onclick: () => replyDialog(r) }, 'Reply') : null;
      reviewsHost.append(h('article', { class: 'review' },
        h('div', { class: 'review-head' }, avatar({ name: r.author_name, avatar: r.author_avatar }, 34), h('strong', null, r.author_name),
          r.verified_visit ? h('span', { class: 'chip chip-ok', title: 'Booked a viewing through the platform' }, icon('check', 12), 'Visited') : null,
          h('span', { class: 'muted small' }, timeAgo(r.created_at))),
        h('div', { class: 'row gap wrap-row small', style: { marginTop: '.4rem' } },
          r.rating_property ? h('span', { class: 'row gap-s' }, 'Place', stars(r.rating_property, 14)) : null,
          r.rating_landlord ? h('span', { class: 'row gap-s' }, 'Landlord', stars(r.rating_landlord, 14)) : null),
        h('p', { class: 'review-body' }, r.body),
        r.reply ? h('div', { class: 'reply-box' }, h('strong', null, 'Landlord reply'), h('div', { class: 'review-body' }, r.reply)) : null,
        h('div', { class: 'actions' }, replyBtn,
          me && (me.id === r.author_id || me.role === 'admin') ? h('button', { onclick: async () => { if (await confirmDialog('Delete review', 'This cannot be undone.', 'Delete', true)) { await del(`/api/reviews/${r.id}`); await refreshStats(); drawReviews(); } } }, 'Delete') : null,
          me && me.id !== r.author_id ? h('button', { onclick: () => reportDialog('review', r.id) }, 'Report') : null)));
    }
  }
  async function refreshStats() { const fresh = await get(`/api/listings/${L.id}`); L.avg_property = fresh.avg_property; L.n_property = fresh.n_property; L.owner = fresh.owner; drawSide(); }

  function reviewForm(existing) {
    let rp = existing?.rating_property || 0; let rl = existing?.rating_landlord || 0;
    const text = h('textarea', { maxlength: 2000, placeholder: 'What was it like? Did the tour match reality? Was the landlord on time and honest?' }); text.value = existing?.body || '';
    const err = h('div', { class: 'form-error', hidden: true });
    const wrap = h('div', { class: 'panel', style: { marginBottom: '1rem' } }, h('h3', null, existing ? 'Edit your review' : 'Write a review'), err,
      h('div', { class: 'row gap wrap-row' }, h('div', null, h('div', { class: 'field-label' }, 'The place'), starInput(rp, (v) => (rp = v))), h('div', null, h('div', { class: 'field-label' }, 'The landlord'), starInput(rl, (v) => (rl = v)))),
      h('div', { style: { marginTop: '.8rem' } }, field('Your review', text, 'Reviews marked "Visited" come from tenants who booked a viewing here.')),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        try { await post(`/api/listings/${L.id}/reviews`, { rating_property: rp || null, rating_landlord: rl || null, body: text.value }); toast('Review saved', 'success'); await refreshStats(); drawReviews(); }
        catch (e) { err.textContent = e.message; err.hidden = false; }
      } }, existing ? 'Update review' : 'Post review'));
    if (!loggedIn) return h('p', null, h('a', { href: '#/login' }, 'Log in'), ' to write a review.');
    return wrap;
  }

  function replyDialog(r) {
    modal('Reply to review', (body, close) => {
      const t = h('textarea', { maxlength: 1000 }); const err = h('div', { class: 'form-error', hidden: true });
      body.append(err, field('Your public reply', t), h('div', { class: 'row end gap' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: async () => { try { await post(`/api/reviews/${r.id}/reply`, { reply: t.value }); close(); drawReviews(); } catch (e) { err.textContent = e.message; err.hidden = false; } } }, 'Post reply')));
    });
  }

  // ---------------------------------------------------------------- comments (public Q&A)
  const commentsHost = h('section', { id: 'comments', style: { marginTop: '2.5rem' } });
  async function drawComments() {
    const { items } = await get(`/api/listings/${L.id}/comments`);
    clear(commentsHost).append(h('h2', null, `Questions and comments (${items.length})`),
      h('p', { class: 'muted small' }, 'Ask about water, power, neighbours or anything the tour does not show. Answers are public so the next tenant benefits too.'));
    const form = (parentId, onDone) => {
      const t = h('textarea', { maxlength: 1000, style: { minHeight: parentId ? '70px' : '90px' }, placeholder: parentId ? 'Write a reply…' : 'Ask a question or leave a comment…' });
      const err = h('div', { class: 'form-error', hidden: true });
      return h('div', null, err, t, h('div', { class: 'row end gap-s', style: { marginTop: '.5rem' } }, parentId ? h('button', { class: 'btn btn-sm', onclick: onDone }, 'Cancel') : null,
        h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          if (!loggedIn) { location.hash = '/login'; return; }
          try { await post(`/api/listings/${L.id}/comments`, { body: t.value, parent_id: parentId || undefined }); drawComments(); } catch (e) { err.textContent = e.message; err.hidden = false; }
        } }, parentId ? 'Reply' : 'Post comment')));
    };
    commentsHost.append(loggedIn ? form(null) : h('p', null, h('a', { href: '#/login' }, 'Log in'), ' to ask a question.'));
    const top = items.filter((c) => !c.parent_id);
    if (!top.length) commentsHost.append(h('p', { class: 'muted', style: { marginTop: '1rem' } }, 'No questions yet.'));
    const node = (c, isChild) => {
      const replyHost = h('div');
      return h('article', { class: 'comment' },
        h('div', { class: 'comment-head' }, avatar({ name: c.author_name, avatar: c.author_avatar }, 30), h('strong', null, c.author_name),
          c.is_landlord ? h('span', { class: 'chip chip-tour' }, 'Landlord') : null, c.is_landlord && c.author_verified ? verifiedBadge('Verified') : null,
          h('span', { class: 'muted small' }, timeAgo(c.created_at))),
        h('p', { class: 'comment-body' }, c.body),
        h('div', { class: 'actions' },
          loggedIn ? h('button', { onclick: () => { clear(replyHost).append(form(c.id, () => clear(replyHost))); } }, 'Reply') : null,
          me && (me.id === c.author_id || me.id === L.owner_id || me.role === 'admin') ? h('button', { onclick: async () => { if (await confirmDialog('Delete comment', 'Replies to it will be removed too.', 'Delete', true)) { await del(`/api/comments/${c.id}`); drawComments(); } } }, 'Delete') : null,
          me && me.id !== c.author_id ? h('button', { onclick: () => reportDialog('comment', c.id) }, 'Report') : null),
        replyHost,
        !isChild ? h('div', { class: 'children' }, items.filter((x) => x.parent_id === c.id).map((x) => node(x, true))) : null);
    };
    top.slice().reverse().forEach((c) => commentsHost.append(node(c, false)));
  }

  // ---------------------------------------------------------------- assemble
  root.append(h('div', { class: 'wrap' },
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/search' }, 'Search'), ' / ', h('a', { href: `#/search?city=${encodeURIComponent(L.city)}` }, L.city), ' / ', L.area),
    h('div', { class: 'listing-grid' },
      h('div', null,
        h('h1', { class: 'listing-title', style: { fontSize: 'clamp(1.6rem,3.4vw,2.3rem)' } }, L.title),
        h('div', { class: 'meta-line' }, h('span', null, icon('pin', 16), ` ${L.area}, ${L.city}`), L.owner.verified ? verifiedBadge() : null,
          L.rooms.length ? h('span', { class: 'chip chip-tour' }, icon('vr', 13), `${plural(L.rooms.length, 'room')} in 360°`) : null),
        tourHost, gallery, facts,
        h('section', null, h('h2', null, 'About this place'), h('p', { style: { whiteSpace: 'pre-wrap' } }, L.description || 'No description yet.')),
        L.amenities.length ? h('section', { style: { marginTop: '1.5rem' } }, h('h2', null, 'What is included'), h('ul', { class: 'amenities' }, L.amenities.map((a) => h('li', null, a)))) : null,
        L.rules ? h('section', { style: { marginTop: '1.5rem' } }, h('h2', null, 'House rules'), h('p', { style: { whiteSpace: 'pre-wrap' } }, L.rules)) : null,
        locationSection, reviewsHost, commentsHost),
      side)));

  drawSide();
  drawReviews().catch(fail); drawComments().catch(fail);
  if (location.hash.includes('#reviews')) setTimeout(() => reviewsHost.scrollIntoView(), 300);

  if (L.lat != null) {
    ensureLeaflet().then(() => {
      miniMap = window.L.map(mapBox, { scrollWheelZoom: false }).setView([L.lat, L.lng], L.exact_location ? 16 : 14);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(miniMap);
      if (L.exact_location) window.L.marker([L.lat, L.lng]).addTo(miniMap); else window.L.circle([L.lat, L.lng], { radius: 350, color: '#2147d0', fillOpacity: 0.12 }).addTo(miniMap);
    }).catch(() => mapBox.append(h('div', { class: 'map-fallback' }, 'The map needs an internet connection.')));
  } else mapBox.remove();

  return () => { tour?.destroy(); try { miniMap?.remove(); } catch { /* ignore */ } };
}
