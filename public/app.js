import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const $ = (id) => document.getElementById(id);
const els = {
  threads: $('threads'), messages: $('messages'), scroll: $('scroll'), input: $('input'), send: $('send'),
  composer: $('composer'), newChat: $('newChat'), title: $('title'), banner: $('banner'), modelInfo: $('modelInfo'),
  sidebar: $('sidebar'), scrim: $('scrim'), menu: $('menu'),
};
const emptyTemplate = $('empty').cloneNode(true);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const state = {
  threadId: null,
  threads: [],
  busy: false,
  controller: null,
  sources: new Map(), // citation number → source, for the whole thread
};

// ───────────────────────── helpers ─────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

function nearBottom() {
  const s = els.scroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}
function scrollDown(force) {
  if (force || nearBottom()) els.scroll.scrollTop = els.scroll.scrollHeight;
}

/**
 * Markdown → safe HTML, with [n] turned into links to the cited source.
 * Citations become private-use placeholder characters *before* parsing and links
 * *after*: injecting <a href="…"> first let the Markdown parser auto-link the URL
 * inside the attribute (inside table cells), which broke the HTML.
 */
const CITE_OPEN = '';
const CITE_CLOSE = '';
function renderMarkdown(text) {
  const clean = text.replaceAll(CITE_OPEN, '').replaceAll(CITE_CLOSE, '');
  const marked_ = clean.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (whole, nums) => {
    const parts = nums.split(/\s*,\s*/).map(Number);
    if (!parts.every((n) => state.sources.has(n))) return whole;
    return parts.map((n) => `${CITE_OPEN}${n}${CITE_CLOSE}`).join('');
  });
  const linked = marked.parse(marked_).replace(new RegExp(`${CITE_OPEN}(\\d+)${CITE_CLOSE}`, 'g'), (_, n) => {
    const s = state.sources.get(Number(n));
    return `<sup class="cite"><a href="${escapeAttr(s.url)}" title="${escapeAttr(s.title)} — ${escapeAttr(s.domain)}">${n}</a></sup>`;
  });
  const html = DOMPurify.sanitize(linked);
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  for (const t of wrap.querySelectorAll('table')) {
    const w = el('div', 'table-wrap');
    t.replaceWith(w);
    w.append(t);
  }
  return wrap.innerHTML;
}
function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ───────────────────────── sidebar ─────────────────────────
async function loadThreads() {
  try {
    state.threads = await (await fetch('/api/threads')).json();
  } catch {
    state.threads = [];
  }
  renderThreads();
}

function renderThreads() {
  els.threads.replaceChildren();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const groups = new Map();
  for (const t of state.threads) {
    const age = Math.round((today - startOfDay(new Date(t.updatedAt))) / 86_400_000);
    const label = age <= 0 ? 'Today' : age === 1 ? 'Yesterday' : age < 7 ? 'Previous 7 days' : age < 30 ? 'Previous 30 days' : 'Older';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  for (const [label, list] of groups) {
    els.threads.append(el('div', 'group-label', label));
    for (const t of list) {
      const b = el('button', `thread${t.id === state.threadId ? ' active' : ''}`);
      b.append(el('span', 'thread-title', t.title));
      if (t.seeded) b.append(el('span', 'tag', 'seeded'));
      const del = el('span', 'thread-del', '×');
      del.title = 'Delete chat';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${t.title}"? It will also be forgotten from memory.`)) return;
        await fetch(`/api/threads/${t.id}`, { method: 'DELETE' });
        if (t.id === state.threadId) newChat();
        loadThreads();
      };
      b.append(del);
      b.onclick = () => openThread(t.id);
      els.threads.append(b);
    }
  }
}

function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.scrim.classList.remove('show');
}

// ───────────────────────── messages ─────────────────────────
function newChat() {
  if (state.busy) stop();
  state.threadId = null;
  state.sources = new Map();
  history.replaceState(null, '', location.pathname);
  els.messages.replaceChildren(emptyTemplate.cloneNode(true));
  bindExamples();
  els.title.textContent = 'New chat';
  renderThreads();
  closeSidebar();
  els.input.focus();
}

async function openThread(id) {
  if (state.busy) stop();
  const res = await fetch(`/api/threads/${id}`);
  if (!res.ok) return newChat();
  const { thread, messages } = await res.json();
  state.threadId = thread.id;
  state.sources = new Map();
  for (const m of messages) for (const s of m.sources ?? []) state.sources.set(s.n, s);
  history.replaceState(null, '', `#${thread.id}`);
  els.title.textContent = thread.title;
  els.messages.replaceChildren();
  for (const m of messages) {
    if (m.role === 'user') addUser(m.content, m.createdAt);
    else {
      const view = addAssistant();
      if (m.recall) view.setMemory(m.recall);
      for (const s of m.searches ?? []) view.addSearch({ query: s.query, since: s.since, mode: s.mode, domains: s.domains }, { count: s.resultCount, error: s.error });
      view.collapseActivity();
      view.setText(m.content);
      view.finish(m);
    }
  }
  renderThreads();
  closeSidebar();
  scrollDown(true);
}

function addUser(text, createdAt) {
  els.messages.querySelector('.empty')?.remove();
  const wrap = el('div', 'msg user');
  const inner = el('div');
  inner.append(el('div', 'bubble', text), el('div', 'msg-time', fmtTime(createdAt ?? new Date().toISOString())));
  wrap.append(inner);
  els.messages.append(wrap);
}

/** A view for one assistant message that can be filled while streaming. */
function addAssistant() {
  const wrap = el('div', 'msg assistant');
  const memory = el('div');
  const activity = el('details', 'activity');
  activity.open = true;
  const summary = el('summary');
  const list = el('ul');
  activity.append(summary, list);
  activity.hidden = true;
  const thinking = el('div', 'thinking');
  thinking.append(el('span', 'spinner'), el('span', null, 'Thinking…'));
  const notice = el('div', 'notice');
  notice.hidden = true;
  const answer = el('div', 'answer');
  const footer = el('div');
  wrap.append(memory, activity, notice, thinking, answer, footer);
  els.messages.append(wrap);

  const searches = new Map();
  let text = '';
  let raf = 0;

  const updateSummary = () => {
    const all = [...searches.values()];
    const pending = all.filter((s) => s.pending).length;
    const results = all.reduce((n, s) => n + (s.count || 0), 0);
    summary.textContent = pending
      ? `Searching the web · ${all.length - pending}/${all.length} done`
      : `Searched ${all.length} ${all.length === 1 ? 'query' : 'queries'} · ${results} results`;
  };

  return {
    setMemory(ev) {
      memory.replaceChildren();
      for (const r of ev.recalled) {
        memory.append(el('span', 'memory-chip', `↺ Recalled: ${r.title} (${new Date(r.day + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })})`));
      }
      for (const d of ev.noRecordFor) memory.append(el('span', 'memory-chip none', `No conversation on record for ${d}`));
    },
    addSearch(s, done) {
      activity.hidden = false;
      thinking.hidden = true;
      const li = el('li');
      const icon = done ? el('span', done.error ? 'err' : 'meta', done.error ? '✕' : '✓') : el('span', 'spinner');
      const filters = [s.mode === 'news' ? 'news' : null, s.since ? `since ${s.since}` : null, s.domains?.length ? s.domains.join(', ') : null].filter(Boolean).join(' · ');
      const meta = el('span', 'meta', done ? (done.error ? done.error : `${done.count} results`) : filters);
      if (done && filters) meta.textContent += ` · ${filters}`;
      li.append(icon, el('span', 'q', s.query), meta);
      list.append(li);
      const id = s.id ?? `h${searches.size}`;
      searches.set(id, { li, icon, meta, filters, pending: !done, count: done?.count ?? 0 });
      updateSummary();
    },
    endSearch(ev) {
      const s = searches.get(ev.id);
      if (!s) return;
      s.pending = false;
      s.count = ev.count;
      const icon = el('span', ev.error ? 'err' : 'meta', ev.error ? '✕' : '✓');
      s.icon.replaceWith(icon);
      s.icon = icon;
      s.meta.textContent = ev.error ? ev.error : `${ev.count} results${s.filters ? ` · ${s.filters}` : ''}`;
      if (ev.error) s.meta.className = 'meta err';
      for (const src of ev.sources) state.sources.set(src.n, src);
      updateSummary();
      if (![...searches.values()].some((x) => x.pending)) {
        thinking.hidden = false;
        thinking.lastChild.textContent = 'Reading results…';
      }
    },
    collapseActivity() {
      activity.open = false;
    },
    reset(message, keep = '') {
      // A step or model is being retried: roll the answer back to `keep`, keep the searches.
      cancelAnimationFrame(raf);
      raf = 0;
      text = keep;
      answer.innerHTML = keep ? renderMarkdown(keep) : '';
      if (message) {
        notice.hidden = false;
        notice.textContent = `↻ ${message}`;
      }
      thinking.hidden = false;
      thinking.lastChild.textContent = 'Retrying…';
    },
    appendText(t) {
      text += t;
      thinking.hidden = true;
      if (searches.size) activity.open = false;
      answer.classList.add('cursor');
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          answer.innerHTML = renderMarkdown(text);
          scrollDown();
        });
      }
    },
    setText(t) {
      text = t;
      thinking.hidden = true;
      answer.innerHTML = renderMarkdown(text);
    },
    finish(msg) {
      cancelAnimationFrame(raf);
      raf = 0;
      thinking.hidden = true;
      answer.classList.remove('cursor');
      if (msg?.content != null) text = msg.content;
      answer.innerHTML = renderMarkdown(text);
      footer.replaceChildren();
      const sources = msg?.sources ?? [];
      if (sources.length) {
        const cited = new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(',').map(Number)));
        const row = el('div', 'sources');
        const shown = sources.filter((s) => cited.has(s.n));
        const rest = sources.filter((s) => !cited.has(s.n));
        const chip = (s) => {
          const a = el('a', 'source');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = `${s.title}${s.published ? ` · published ${s.published}` : ''}`;
          a.append(el('b', null, String(s.n)), el('span', null, s.domain));
          return a;
        };
        (shown.length ? shown : rest.slice(0, 6)).forEach((s) => row.append(chip(s)));
        if (shown.length && rest.length) {
          const more = el('button', 'more-sources', `+${rest.length} more consulted`);
          more.onclick = () => (rest.forEach((s) => row.append(chip(s))), more.remove());
          row.append(more);
        }
        footer.append(row);
      }
      if (msg?.status === 'aborted') footer.append(el('div', 'status-note', 'Stopped before finishing.'));
      if (msg?.status === 'error' && !text.trim() && msg.id) footer.append(el('div', 'error-box', 'This answer failed (the model provider returned an error). Ask again to retry.'));
      const unsupported = msg?.verification?.unsupported ?? [];
      if (unsupported.length) {
        const warn = el('details', 'verify-warn');
        warn.append(el('summary', null, `⚠ ${unsupported.length} figure${unsupported.length > 1 ? 's' : ''} not found in the cited source text: worth double-checking`));
        const ul = el('ul');
        for (const u of unsupported) {
          const li = el('li');
          li.append(el('b', null, u.value), document.createTextNode(` cited to [${u.cites.join('][')}]: “${u.context}”`));
          ul.append(li);
        }
        warn.append(ul);
        footer.append(warn);
      }
      if (msg?.trace) {
        const btn = el('button', 'inspect-btn', 'Inspect');
        btn.title = 'How this answer was produced';
        let panel = null;
        btn.onclick = () => {
          if (panel) {
            panel.remove();
            panel = null;
            btn.classList.remove('on');
            return;
          }
          panel = renderInspect(msg);
          btn.after(panel);
          btn.classList.add('on');
        };
        footer.append(btn);
      }
    },
    error(message) {
      thinking.hidden = true;
      answer.classList.remove('cursor');
      footer.append(el('div', 'error-box', message));
    },
    get text() {
      return text;
    },
  };
}

// ───────────────────────── inspect panel ─────────────────────────
/** Shows how an answer was produced: dates, memory, model steps, searches, checks. */
function renderInspect(msg) {
  const t = msg.trace;
  const secs = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
  const num = (n) => (n == null ? '–' : n.toLocaleString());
  const panel = el('div', 'inspect');

  const kv = el('div', 'kv');
  const pair = (k, v) => {
    const d = el('div');
    d.append(el('span', null, k), el('b', null, v));
    kv.append(d);
  };
  pair('Model', t.model || '–');
  pair('First token', secs(t.firstTokenMs));
  pair('Total', secs(t.totalMs));
  pair('Pre-flight', `${t.preflightMs} ms`);
  pair('Chat history sent', `${t.historyMessages} msgs`);
  panel.append(kv);

  const section = (title) => panel.append(el('h4', null, title));
  const list = (items) => {
    const ul = el('ul');
    items.forEach((x) => ul.append(el('li', null, x)));
    panel.append(ul);
  };
  const table = (head, rows) => {
    const tb = el('table');
    const tr = el('tr');
    head.forEach((h) => tr.append(el('th', null, h)));
    tb.append(tr);
    for (const r of rows) {
      const row = el('tr');
      r.forEach((c) => row.append(el('td', null, String(c))));
      tb.append(row);
    }
    const w = el('div', 'table-wrap');
    w.append(tb);
    panel.append(w);
  };

  if (t.fallbacks?.length) {
    section('Model fallbacks');
    list(t.fallbacks.map((f) => `${f.from} ${f.reason} → ${f.to}`));
  }

  section('Dates resolved (in code, not by the model)');
  if (t.dates.length) list(t.dates.map((d) => `“${d.phrase}” → ${d.resolved}${d.alternatives.length ? `  (or ${d.alternatives.join(' / ')})` : ''}`));
  else panel.append(el('p', 'muted', 'No date references.'));

  const rec = msg.recall;
  section('Memory');
  panel.append(el('p', 'muted',
    (rec?.recalled?.length ? `Recalled in full: ${rec.recalled.map((r) => `${r.title} (${r.day})`).join(', ')}.` : 'Nothing recalled in full.') +
    (rec?.noRecordFor?.length ? ` No record for: ${rec.noRecordFor.join(', ')}.` : '')));

  section('Model steps');
  table(['#', 'time', 'input tok (cached)', 'output tok', 'tool calls', 'finish'],
    t.steps.map((s, i) => [
      i + 1,
      secs(s.ms),
      `${num(s.inputTokens)}${s.cachedInputTokens ? ` (${num(s.cachedInputTokens)})` : ''}`,
      `${num(s.outputTokens)}${s.reasoningTokens ? ` +${num(s.reasoningTokens)} thinking` : ''}`,
      s.toolCalls,
      s.finishReason,
    ]));

  if (msg.searches?.length) {
    section('Searches');
    table(['query', 'filters', 'results', 'time'],
      msg.searches.map((s) => [
        s.query,
        [s.mode === 'news' ? 'news' : '', s.since ? `since ${s.since}` : '', s.domains?.join(', ') ?? ''].filter(Boolean).join(' · ') || '–',
        s.error ? `error: ${s.error}` : s.resultCount,
        secs(s.ms),
      ]));
  }

  const v = msg.verification;
  section('Citation check');
  panel.append(el('p', 'muted',
    !v || !v.checked ? 'No cited figures to check.'
      : v.unsupported.length ? `${v.checked} cited figures checked, ${v.unsupported.length} not found in their source.`
      : `${v.checked} cited figure${v.checked > 1 ? 's' : ''} checked, all found in the cited source text.`));

  if (t.limits?.length) {
    section('Limits hit');
    list(t.limits);
  }

  const ctx = el('details');
  ctx.append(el('summary', null, 'Context given to the model this turn (clock, dates, memory)'), el('pre', null, t.context));
  panel.append(ctx);
  return panel;
}

// ───────────────────────── sending ─────────────────────────
async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  state.busy = true;
  setComposerBusy(true);
  els.input.value = '';
  autosize();
  addUser(text);
  const view = addAssistant();
  scrollDown(true);

  const controller = new AbortController();
  state.controller = controller;
  let finished = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: state.threadId, message: text, tz }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    for await (const { event, data } of readSSE(res.body)) {
      switch (event) {
        case 'meta':
          if (state.threadId !== data.threadId) {
            state.threadId = data.threadId;
            history.replaceState(null, '', `#${data.threadId}`);
            els.title.textContent = data.title;
            loadThreads();
          }
          break;
        case 'memory':
          view.setMemory(data);
          break;
        case 'search-start':
          view.addSearch(data);
          scrollDown();
          break;
        case 'search-end':
          view.endSearch(data);
          break;
        case 'delta':
          view.appendText(data.text);
          break;
        case 'retry':
          view.reset(data.message, data.text);
          break;
        case 'done':
          finished = true;
          view.finish(data.message);
          break;
        case 'error':
          finished = true;
          view.finish({ content: view.text, sources: [] });
          view.error(data.message);
          break;
      }
    }
    if (!finished) view.finish({ content: view.text, status: controller.signal.aborted ? 'aborted' : undefined });
  } catch (err) {
    if (controller.signal.aborted) view.finish({ content: view.text, status: 'aborted' });
    else {
      view.finish({ content: view.text });
      view.error(err.message === 'Failed to fetch' ? 'Could not reach the server. Is it still running?' : err.message);
    }
  } finally {
    state.busy = false;
    state.controller = null;
    setComposerBusy(false);
    scrollDown();
    loadThreads();
    // The background digest renames new chats a few seconds later.
    setTimeout(loadThreads, 5000);
  }
}

async function* readSSE(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trimStart();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

function stop() {
  state.controller?.abort();
}

function setComposerBusy(busy) {
  els.send.classList.toggle('stop', busy);
  els.send.textContent = busy ? '■' : '↑';
  els.send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  els.send.disabled = !busy && !els.input.value.trim();
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 220)}px`;
  if (!state.busy) els.send.disabled = !els.input.value.trim();
}

function bindExamples() {
  for (const b of document.querySelectorAll('.example')) b.onclick = () => send(b.textContent);
}

// ───────────────────────── wiring ─────────────────────────
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) stop();
  else send(els.input.value);
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.busy) send(els.input.value);
  }
});
els.input.addEventListener('input', autosize);
els.newChat.onclick = newChat;
els.menu.onclick = () => (els.sidebar.classList.add('open'), els.scrim.classList.add('show'));
els.scrim.onclick = closeSidebar;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    newChat();
  }
  if (e.key === 'Escape' && state.busy) stop();
});

(async function init() {
  bindExamples();
  setComposerBusy(false);
  try {
    const h = await (await fetch('/api/health')).json();
    els.modelInfo.textContent = h.model ? `${h.provider} · ${h.model}${h.search ? ' · web search on' : ''}` : 'Model not configured';
    if (h.fallbacks?.length) els.modelInfo.title = `Fallbacks: ${h.fallbacks.join(' → ')}`;
    if (h.problems.length) {
      els.banner.hidden = false;
      els.banner.innerHTML = h.problems.map((p) => `⚠ ${escapeAttr(p)}`).join('<br>');
    }
  } catch {}
  await loadThreads();
  const id = location.hash.slice(1);
  if (id && state.threads.some((t) => t.id === id)) openThread(id);
  else els.input.focus();
})();
