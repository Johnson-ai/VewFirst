import { h, clear, state, get, post, icon, fail, avatar, timeAgo, emptyState, refreshCounters } from '../lib.js';
import { renderHeader } from '../app.js';

export default async function messages(root, [activeId]) {
  if (!state.user) { location.hash = '/login'; return; }
  const list = h('div', { class: 'msg-list' });
  const thread = h('div', { class: 'msg-thread' });
  const layout = h('div', { class: `msg-layout ${activeId ? 'has-thread' : ''}` }, list, thread);
  root.append(h('div', { class: 'wrap page', style: { paddingBottom: '1rem' } }, h('h1', { style: { fontSize: '2rem' } }, 'Messages'), layout));
  let timer = null; let lastId = 0; let body = null; let alive = true;

  async function drawList() {
    const { items } = await get('/api/conversations');
    clear(list);
    if (!items.length) { list.append(emptyState('No conversations yet', 'Message a landlord from any listing to start one.', h('a', { class: 'btn', href: '#/search' }, 'Find a place'))); return; }
    items.forEach((c) => list.append(h('a', { class: `msg-item ${String(c.id) === String(activeId) ? 'on' : ''}`, href: `#/messages/${c.id}` },
      avatar(c.other, 40), h('div', { class: 'grow' }, h('div', { class: 'row between gap-s' }, h('strong', null, c.other.name), h('span', { class: 'small muted' }, timeAgo(c.last_message_at))),
        h('div', { class: 'small muted', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, c.listing_title), h('div', { class: 'snip' }, c.last_body || '')),
      c.unread ? h('span', { class: 'pip', style: { position: 'static' } }, c.unread) : null)));
  }

  function bubble(m) {
    return h('div', { class: `bubble ${m.sender_id === state.user.id ? 'me' : ''}` }, m.body, h('time', null, timeAgo(m.created_at)));
  }

  async function openThread() {
    clear(thread);
    if (!activeId) { thread.append(h('div', { class: 'msg-empty' }, h('h3', null, 'Pick a conversation'), h('p', null, 'Keep all talk about a place here so there is a record if something goes wrong.'))); return; }
    let first;
    try { first = await get(`/api/conversations/${activeId}/messages`); } catch (e) { thread.append(emptyState('Conversation not found', e.message)); return; }
    const c = first.conversation;
    body = h('div', { class: 'msg-body' });
    const ta = h('textarea', { maxlength: 2000, placeholder: 'Write a message…', 'aria-label': 'Message', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    async function send() {
      const text = ta.value.trim(); if (!text) return;
      ta.value = '';
      try { await post(`/api/conversations/${activeId}/messages`, { body: text }); await poll(); } catch (e) { ta.value = text; fail(e); }
    }
    thread.append(
      h('div', { class: 'msg-head' }, h('a', { class: 'icon-btn msg-back', href: '#/messages', 'aria-label': 'Back to conversations' }, icon('left', 20)), avatar(c.other, 36),
        h('div', { class: 'grow' }, h('strong', null, c.other.name), h('div', { class: 'small' }, h('a', { href: `#/listing/${c.listing_id}` }, c.listing_title)))),
      body,
      h('div', { class: 'notice', style: { margin: '0', borderRadius: 0, fontSize: '.82rem' } }, 'Never pay before you have visited and met the landlord. Keep messages here.'),
      h('div', { class: 'msg-compose' }, ta, h('button', { class: 'btn btn-primary', onclick: send, 'aria-label': 'Send' }, icon('send', 16))));
    first.items.forEach((m) => { body.append(bubble(m)); lastId = m.id; });
    if (!first.items.length) body.append(h('div', { class: 'msg-empty' }, 'Say hello.'));
    body.scrollTop = body.scrollHeight;
    timer = setInterval(poll, 5000);
  }

  async function poll() {
    if (!alive || !body || document.hidden) return;
    try {
      const r = await get(`/api/conversations/${activeId}/messages?after=${lastId}`);
      if (r.items.length) {
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        body.querySelector('.msg-empty')?.remove();
        r.items.forEach((m) => { body.append(bubble(m)); lastId = m.id; });
        if (atBottom || r.items.some((m) => m.sender_id === state.user.id)) body.scrollTop = body.scrollHeight;
        drawList(); refreshCounters().then(renderHeader);
      }
    } catch { /* transient */ }
  }

  await Promise.all([drawList(), openThread()]);
  refreshCounters().then(renderHeader);
  return () => { alive = false; clearInterval(timer); };
}
