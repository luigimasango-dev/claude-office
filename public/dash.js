// Claude HQ — desktop control room panels.
//
// The pixel office in app.js owns the SSE connection and the canvas; this file
// hangs the roster table, the activity feed and the stat tiles off the same
// stream via window.onRoster. Helper functions (nameFor, titleFor, fmtTokens,
// fmtElapsed, activityLine) come from app.js, which is a classic script, so its
// top-level declarations are already global.
'use strict';

const rosterEl = document.getElementById('roster');
const feedEl = document.getElementById('feed');
const rosterCountEl = document.getElementById('roster-count');

const MAX_EVENTS = 80;
let lastQueued = 0;   // queue depth from the most recent server push
const lastLine = new Map();   // character id -> last activity line we logged
const known = new Map();      // character id -> display name, for join/leave
let events = [];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function clockOf(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function kindClass(c) {
  return c.kind === 'opencode' ? 'is-oc' : (c.kind === 'main' ? 'is-main' : 'is-sub');
}

function pushEvent(ev) {
  events.unshift(ev);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------
function renderTiles(roster) {
  const working = roster.filter(c => c.status === 'working').length;
  const chilling = roster.filter(c => c.status === 'chilling').length;
  const ocRunning = roster.filter(c => c.kind === 'opencode' && c.running);
  // Context size of the running OpenCode jobs — the number worth watching,
  // since that's what actually moves while a job grinds.
  const ctx = ocRunning.reduce((n, c) => n + (c.ctxTokens || 0), 0);

  document.getElementById('tile-working').textContent = working;
  document.getElementById('tile-chilling').textContent = chilling;
  document.getElementById('tile-oc').textContent = ocRunning.length;
  document.getElementById('tile-ctx').textContent = ctx ? fmtTokens(ctx) : '—';

  // Queue depth belongs next to the roster count — it is the "and how much is
  // still coming" number that a fan-out to ten agents creates.
  const qEl = document.getElementById('roster-count');
  if (qEl && typeof lastQueued === 'number') {
    qEl.textContent = lastQueued
      ? `${roster.length} on the floor · ${lastQueued} queued`
      : `${roster.length} on the floor`;
  }
}

// ---------------------------------------------------------------------------
// Roster table
// ---------------------------------------------------------------------------
function rowHtml(c) {
  const name = nameFor(c);
  const title = titleFor(c);
  const line = activityLine(c);
  const dotCls = c.stalled ? 'stalled' : c.status;

  let act;
  if (line && c.status === 'working') {
    const a = c.activity || {};
    act = a.tool
      ? `<span class="act-tool">${esc(a.tool)}</span><span class="act-detail">${esc(a.detail || '')}</span>`
      : `<span class="act-detail">${esc(line)}</span>`;
  } else {
    act = `<span class="act-idle">${esc(c.desc || 'idle')}</span>`;
  }

  let meta;
  if (c.kind === 'opencode') {
    meta = `<b>${esc(fmtElapsed(c.elapsedMs || 0))}</b>${esc(c.model || '')} · ${esc(fmtTokens(c.ctxTokens))} ctx`;
  } else {
    const ago = Math.round((Date.now() - c.lastActive) / 1000);
    meta = `<b>${ago < 90 ? ago + 's' : Math.round(ago / 60) + 'm'}</b>${esc(c.project || '')}`;
  }

  return `<div class="row ${kindClass(c)}">
    <span class="dot ${dotCls}"></span>
    <div class="who">
      <div class="who-name">${esc(name)}${c.stalled ? ' ⚠' : ''}</div>
      <div class="who-sub">${esc(title)}</div>
    </div>
    <div class="act">${act}</div>
    <div class="meta">${meta}</div>
  </div>`;
}

function renderRoster(roster) {
  if (!roster.length) {
    rosterEl.innerHTML = `<div class="empty">nobody on the floor — everyone's gone home 🌙</div>`;
    rosterCountEl.textContent = '0 on the floor';
    return;
  }
  // Working first, then OpenCode ahead of Claude within each status band, so
  // the thing you actually dispatched is never buried under idle sessions.
  const order = { working: 0, chilling: 1 };
  const sorted = roster.slice().sort((a, b) =>
    (order[a.status] - order[b.status]) ||
    ((b.kind === 'opencode') - (a.kind === 'opencode')) ||
    b.lastActive - a.lastActive
  );
  rosterEl.innerHTML = sorted.map(rowHtml).join('');
  rosterCountEl.textContent = `${roster.length} on the floor`;
}

// ---------------------------------------------------------------------------
// Activity feed — one line per genuine change, not per poll
// ---------------------------------------------------------------------------
function renderFeed() {
  if (!events.length) {
    feedEl.innerHTML = `<div class="empty">waiting for something to happen…</div>`;
    return;
  }
  feedEl.innerHTML = events.map(e => `<div class="ev ${e.cls}">
    <span class="ev-time">${esc(e.time)}</span>
    <span class="ev-who">${esc(e.who)}</span>
    <span class="ev-what" title="${esc(e.what)}">${esc(e.what)}</span>
  </div>`).join('');
}

function diffFeed(roster, at) {
  const seen = new Set();
  for (const c of roster) {
    seen.add(c.id);
    const name = nameFor(c);
    if (!known.has(c.id)) {
      known.set(c.id, name);
      pushEvent({ time: clockOf(at), who: name, what: `clocked in — ${c.desc || ''}`.trim(), cls: `${kindClass(c)} is-join` });
    }
    const line = activityLine(c);
    if (line && line !== lastLine.get(c.id)) {
      lastLine.set(c.id, line);
      pushEvent({ time: clockOf(at), who: name, what: line, cls: kindClass(c) });
    }
  }
  for (const [id, name] of known) {
    if (seen.has(id)) continue;
    known.delete(id);
    lastLine.delete(id);
    pushEvent({ time: clockOf(at), who: name, what: 'went home', cls: 'is-left' });
  }
}

// ---------------------------------------------------------------------------
window.onRoster = function (state) {
  const roster = state.characters || [];
  const at = state.generatedAt || Date.now();
  lastQueued = state.queued || 0;
  renderTiles(roster);
  renderRoster(roster);
  diffFeed(roster, at);
  renderFeed();
};

renderFeed();

// ---------------------------------------------------------------------------
// Hire a contractor — type or speak a brief, dispatch it to OpenCode
// ---------------------------------------------------------------------------
const sayAgents = document.getElementById('say-agents');
const sayAll = document.getElementById('say-all');
const sayNone = document.getElementById('say-none');
const sayCwd = document.getElementById('say-cwd');
const sayBrief = document.getElementById('say-brief');
const sayGo = document.getElementById('say-go');
const sayMic = document.getElementById('say-mic');
const sayStatus = document.getElementById('say-status');

function status(text, cls) {
  sayStatus.textContent = text;
  sayStatus.className = 'pane-note' + (cls ? ' ' + cls : '');
}

// These two refuse to run without something the dashboard cannot supply — a
// signed authorization, or a decision about live capital. Marked, not hidden.
const GATED = new Set(['osint-recon', 'backtest-runner']);
const selected = new Set();

function selectionSummary() {
  if (!selected.size) return 'default agent';
  if (selected.size === 1) return [...selected][0];
  return `${selected.size} agents`;
}

// Built from what is actually on disk, so a newly added agent appears here
// without anyone editing this file.
fetch('/api/agents').then(r => r.json()).then(d => {
  for (const name of d.agents || []) {
    const chip = document.createElement('span');
    chip.className = 'agchip' + (GATED.has(name) ? ' gated' : '');
    chip.textContent = name;
    chip.dataset.agent = name;
    if (GATED.has(name)) {
      chip.title = name === 'osint-recon'
        ? 'Refuses to run without a signed client authorization named in the brief.'
        : 'Never touches the live-trading gates. Cached backtest data only.';
    }
    chip.addEventListener('click', () => {
      if (selected.has(name)) { selected.delete(name); chip.classList.remove('on'); }
      else { selected.add(name); chip.classList.add('on'); }
      status(`target: ${selectionSummary()}`);
    });
    sayAgents.appendChild(chip);
  }
}).catch(() => {});

function setAll(on) {
  selected.clear();
  for (const chip of sayAgents.querySelectorAll('.agchip')) {
    if (on) { selected.add(chip.dataset.agent); chip.classList.add('on'); }
    else chip.classList.remove('on');
  }
  status(`target: ${selectionSummary()}`);
}
sayAll.addEventListener('click', () => setAll(true));
sayNone.addEventListener('click', () => setAll(false));

// Clicking a contractor on the floor targets that agent — talk to one directly.
window.targetAgent = function (name) {
  if (!name) return;
  const chip = sayAgents.querySelector(`.agchip[data-agent="${CSS.escape(name)}"]`);
  if (!chip) return;
  setAll(false);
  selected.add(name);
  chip.classList.add('on');
  status(`target: ${name}`);
  sayBrief.focus();
};

async function doDispatch() {
  const brief = sayBrief.value.trim();
  if (!brief) { status('nothing to say', 'err'); sayBrief.focus(); return; }
  sayGo.disabled = true;
  status('dispatching…');
  try {
    const r = await fetch('/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brief,
        agents: [...selected],
        cwd: sayCwd.value.trim(),
        label: brief.split('\n')[0].slice(0, 60),
      }),
    });
    const d = await r.json();
    if (d.error) { status(d.error, 'err'); return; }
    if (d.queued) {
      status(`queued ${d.queued} — releasing 2 at a time (${d.depth} waiting)`, 'ok');
    } else {
      status(`hired — ${d.agent} in ${d.cwd.split(/[\\/]/).pop()}`, 'ok');
    }
    sayBrief.value = '';
    // The roster refreshes on the next SSE tick; the new hire walks in then.
  } catch (e) {
    status('dispatch failed: ' + e.message, 'err');
  } finally {
    sayGo.disabled = false;
  }
}

sayGo.addEventListener('click', doDispatch);
// Ctrl/Cmd+Enter sends; plain Enter keeps writing, because briefs are multi-line.
sayBrief.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doDispatch(); }
});

// Voice. Chrome's built-in SpeechRecognition needs no external host — which is
// the only reason this works. A hosted artifact could never reach the machine
// the agents actually run on.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  sayMic.disabled = true;
  sayMic.title = 'This browser has no built-in speech recognition — Chrome does.';
} else {
  const rec = new SR();
  rec.lang = 'en-ZA';
  rec.continuous = true;
  rec.interimResults = true;
  let listening = false;
  let settled = '';   // text already finalised this session

  rec.onstart = () => { listening = true; sayMic.classList.add('rec'); sayMic.textContent = '■ stop'; status('listening…'); };
  rec.onerror = (e) => status('mic: ' + e.error, 'err');
  rec.onend = () => {
    listening = false;
    sayMic.classList.remove('rec');
    sayMic.textContent = '🎙 speak';
    if (sayStatus.textContent === 'listening…') status('idle');
  };
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const chunk = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) settled += chunk;
      else interim += chunk;
    }
    sayBrief.value = (settled + interim).replace(/\s+/g, ' ').trimStart();
  };

  sayMic.addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    settled = sayBrief.value ? sayBrief.value.trim() + ' ' : '';
    try { rec.start(); } catch (e) { status('mic unavailable: ' + e.message, 'err'); }
  });
}

// Keep the "last active" column honest between server pushes — the SSE stream
// only fires when something actually changes, which can be a while at 3am.
setInterval(() => {
  const el = rosterEl.querySelector('.row');
  if (!el) return;
  for (const b of rosterEl.querySelectorAll('.row:not(.is-oc) .meta b')) {
    const m = b.textContent.match(/^(\d+)s$/);
    if (m) {
      const n = Number(m[1]) + 1;
      b.textContent = n < 90 ? `${n}s` : `${Math.round(n / 60)}m`;
    }
  }
}, 1000);
