// Claude HQ — pixel office, driven by live Claude Code session data.
'use strict';

// ---------------------------------------------------------------------------
// Telegram Mini App bootstrap
// ---------------------------------------------------------------------------
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setBackgroundColor('#0e0f1a'); tg.setHeaderColor('#0e0f1a'); } catch (e) {}
}

// ---------------------------------------------------------------------------
// World constants (logical pixel grid, scaled up to the screen)
// ---------------------------------------------------------------------------
const W = 240, H = 360;
const WALL_H = 56;            // wall band at the top (windows live here)
const DESK_ZONE_TOP = 78;
const LOUNGE_TOP = 250;       // lounge below this line
const DOOR = { x: 10, y: H - 30 };

const DESK_W = 34, DESK_H = 18;
const DESK_SLOTS = [];
for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 2; col++) {
    DESK_SLOTS.push({ x: 34 + col * 120, y: DESK_ZONE_TOP + 14 + row * 42 });
  }
}

// Fixed, spread-out lounge spots so chillers don't stack on top of each
// other and vanish into a single blob. Each spot gets a small random jitter
// radius at assignment time, not a fully random point across the whole rug.
const LOUNGE_SLOTS = [
  { x: 40, y: LOUNGE_TOP + 30 }, { x: 70, y: LOUNGE_TOP + 24 },
  { x: 100, y: LOUNGE_TOP + 30 }, { x: 130, y: LOUNGE_TOP + 24 },
  { x: 45, y: LOUNGE_TOP + 58 }, { x: 80, y: LOUNGE_TOP + 62 },
  { x: 115, y: LOUNGE_TOP + 58 }, { x: 145, y: LOUNGE_TOP + 66 },
];

const NAMES = ['Pixel','Byte','Turing','Ada','Vector','Mango','Tofu','Widget','Gizmo','Nimbus','Quark','Beep','Socket','Kernel','Dot','Echo','Fizz','Mocha','Bit','Zippy','Pascal','Lambda','Curie','Hopper'];
// OpenCode runs are hired contractors, not staff — they get their own roster.
const OC_NAMES = ['Rusty','Bolt','Dozer','Chisel','Ratchet','Forge','Crank','Wrench','Auger','Rivet','Grit','Spanner'];
const TITLES = {
  'claude': 'Principal Agent',
  'general-purpose': 'Generalist',
  'Explore': 'Scout',
  'Plan': 'Architect',
  'code-reviewer': 'Reviewer',
  'compliance-verifier': 'Compliance Officer',
  'quant-strategist': 'Quant',
  'statistical-skeptic': 'Skeptic',
  'opencode': 'Contractor',
};

function nowSec() { return performance.now() / 1000; } // same clock the frame loop uses
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function nameFor(c) {
  if (c.kind === 'main') return 'Claude';
  if (c.kind === 'opencode') return OC_NAMES[hashStr(c.id) % OC_NAMES.length];
  return NAMES[hashStr(c.id) % NAMES.length];
}
function titleFor(c) {
  if (TITLES[c.agentType]) return TITLES[c.agentType];
  return c.agentType.replace(/[-_]/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
}
function colorFor(c) {
  if (c.kind === 'main') return { body: '#e8845c', trim: '#c96a45' };   // Claude coral
  if (c.kind === 'opencode') return { body: '#3fb8c4', trim: '#2a8792' }; // contractor teal
  const hue = hashStr(c.agentType) % 360;
  return { body: `hsl(${hue} 55% 58%)`, trim: `hsl(${hue} 55% 42%)` };
}

// "Read: server.js" / "bash: pdftotext …" — what they're doing this second.
function activityLine(data) {
  const a = data.activity;
  if (!a) return null;
  if (a.tool) return a.detail ? `${a.tool}: ${a.detail}` : a.tool;
  return a.detail || a.say || null;
}
function fmtTokens(n) {
  if (!n) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let scale = 1, offX = 0, offY = 0;

// Size to the canvas's own CSS box, not the window — in the Telegram shell CSS
// makes that the full viewport anyway, and on the desktop dashboard it's a
// panel in a grid. One renderer, two shells.
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(Math.max(1, rect.width) * dpr);
  canvas.height = Math.floor(Math.max(1, rect.height) * dpr);
  scale = Math.min(canvas.width / W, canvas.height / H);
  offX = (canvas.width - W * scale) / 2;
  offY = (canvas.height - H * scale) / 2;
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener('resize', resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
resize();

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------
const chars = new Map();   // id -> character (visual + data)
let particles = [];
let bubbles = [];
const cat = { x: 120, y: 300, tx: 160, ty: 310, pauseUntil: 0, flip: false };

function mergeRoster(roster) {
  const seen = new Set();
  const workingIds = roster.filter(c => c.status === 'working').map(c => c.id);

  for (const data of roster) {
    seen.add(data.id);
    let ch = chars.get(data.id);
    if (!ch) {
      ch = {
        id: data.id, data,
        x: DOOR.x, y: DOOR.y, tx: DOOR.x, ty: DOOR.y,
        mode: 'walking', deskIdx: -1, loungeIdx: -1,
        phase: (hashStr(data.id) % 1000) / 1000,
        pauseUntil: 0, leaving: false, flip: false,
        name: nameFor(data), title: titleFor(data), col: colorFor(data),
      };
      chars.set(data.id, ch);
      spawnSparkle(DOOR.x, DOOR.y - 10);
      ch.lastActLine = activityLine(data);
    } else {
      // When what they're doing changes, say so immediately rather than
      // waiting for the random bubble timer — this is the whole point.
      const line = activityLine(data);
      if (line && line !== ch.lastActLine && data.status === 'working') {
        bubbles = bubbles.filter(b => b.chId !== ch.id);
        bubbles.push({ chId: ch.id, text: trunc(line, 34), until: nowSec() + 5 });
      }
      ch.lastActLine = line;
      ch.data = data;
      ch.leaving = false;
    }
  }

  // Assign desks to working characters, lounge to chillers.
  // Sticky seating: keep your desk while you work; newcomers take free slots.
  const taken = new Set();
  for (const id of workingIds) {
    const ch = chars.get(id);
    if (ch && ch.deskIdx >= 0 && !taken.has(ch.deskIdx)) taken.add(ch.deskIdx);
    else if (ch) ch.deskIdx = -1;
  }
  for (const id of workingIds) {
    const ch = chars.get(id);
    if (!ch) continue;
    if (ch.deskIdx >= 0 && ch.mode !== 'lounge') continue; // already seated or en route
    let idx = -1;
    for (let i = 0; i < DESK_SLOTS.length; i++) if (!taken.has(i)) { idx = i; break; }
    if (idx >= 0) taken.add(idx);
    ch.deskIdx = idx;
    const d = idx >= 0 ? DESK_SLOTS[idx] : { x: 200, y: 120 + (taken.size * 20) % 100 };
    ch.tx = d.x + DESK_W / 2;
    ch.ty = d.y + DESK_H + 8;
    ch.mode = 'walking'; ch.next = 'desk';
  }
  // Seed with anyone already AT a lounge slot or currently walking to one —
  // not just arrivals — so agents that go chilling in different SSE ticks
  // don't both claim the same slot before either arrives.
  const loungeTaken = new Set();
  for (const [, ch] of chars) {
    if (ch.leaving || ch.loungeIdx < 0) continue;
    if (ch.mode === 'lounge' || (ch.mode === 'walking' && ch.next === 'lounge')) loungeTaken.add(ch.loungeIdx);
  }
  for (const [id, ch] of chars) {
    if (!seen.has(id)) { ch.leaving = true; ch.mode = 'walking'; ch.next = 'gone'; ch.tx = DOOR.x; ch.ty = DOOR.y; continue; }
    if (ch.data.status === 'chilling' && ch.mode !== 'lounge' && ch.next !== 'lounge' && !ch.leaving) {
      ch.deskIdx = -1;
      let idx = -1;
      for (let i = 0; i < LOUNGE_SLOTS.length; i++) if (!loungeTaken.has(i)) { idx = i; break; }
      if (idx < 0) idx = Math.floor(Math.random() * LOUNGE_SLOTS.length); // overflow: share a spot
      loungeTaken.add(idx);
      ch.loungeIdx = idx;
      const s = LOUNGE_SLOTS[idx];
      ch.tx = s.x + (Math.random() - 0.5) * 8;
      ch.ty = s.y + (Math.random() - 0.5) * 8;
      ch.mode = 'walking'; ch.next = 'lounge';
    }
  }
  updateHud(roster);
}

function updateHud(roster) {
  const w = roster.filter(c => c.status === 'working').length;
  const c = roster.filter(c => c.status === 'chilling').length;
  const oc = roster.filter(c => c.kind === 'opencode' && c.running);
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('stat-working', `${w} working`);
  set('stat-chilling', `${c} chilling`);
  const ocEl = document.getElementById('stat-opencode');
  if (ocEl) {
    ocEl.textContent = oc.length ? `${oc.length} opencode` : '';
    ocEl.style.display = oc.length ? '' : 'none';
  }
}

// SSE feed. The desktop dashboard hangs its own panels off window.onRoster
// rather than opening a second EventSource against the same server.
const connEl = document.getElementById('hud-conn');
function setConn(text, cls) { if (connEl) { connEl.textContent = text; connEl.className = cls; } }
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => setConn('● live', 'live');
  es.onmessage = (ev) => {
    let state; try { state = JSON.parse(ev.data); } catch (e) { return; }
    mergeRoster(state.characters);
    if (typeof window.onRoster === 'function') {
      try { window.onRoster(state); } catch (e) { console.error('onRoster', e); }
    }
  };
  es.onerror = () => setConn('○ reconnecting', 'dead');
}
connect();

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
const SPEED = 28; // world px / s

function step(dt, t) {
  for (const [id, ch] of chars) {
    if (ch.mode === 'walking') {
      const dx = ch.tx - ch.x, dy = ch.ty - ch.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.5) {
        ch.x = ch.tx; ch.y = ch.ty;
        if (ch.next === 'gone') { chars.delete(id); spawnSparkle(ch.x, ch.y - 8); continue; }
        ch.mode = ch.next === 'desk' ? 'desk' : 'lounge';
        ch.pauseUntil = t + 2 + Math.random() * 6;
      } else {
        ch.x += (dx / dist) * SPEED * dt;
        ch.y += (dy / dist) * SPEED * dt;
        ch.flip = dx < 0;
      }
    } else if (ch.mode === 'lounge') {
      if (t > ch.pauseUntil) {
        // wander near your assigned lounge spot (sometimes the coffee machine),
        // not to a fully random rug point — keeps chillers from clumping.
        const coffee = Math.random() < 0.35;
        const home = LOUNGE_SLOTS[ch.loungeIdx] || { x: 80, y: LOUNGE_TOP + 40 };
        ch.tx = coffee ? 206 : home.x + (Math.random() - 0.5) * 16;
        ch.ty = coffee ? 268 : home.y + (Math.random() - 0.5) * 16;
        ch.mode = 'walking'; ch.next = 'lounge';
      }
    } else if (ch.mode === 'desk' && ch.data.status === 'working') {
      // typing particles
      if (Math.random() < dt * 2.2 && ch.deskIdx >= 0) {
        const d = DESK_SLOTS[ch.deskIdx];
        particles.push({ x: d.x + 8 + Math.random() * 18, y: d.y - 2, vy: -9 - Math.random() * 6, life: 1, hue: 130 + Math.random() * 60 });
      }
      // occasional speech bubble — live activity if we have it, else the task
      if (Math.random() < dt * 0.06 && !bubbles.find(b => b.chId === ch.id)) {
        const line = activityLine(ch.data) || ch.data.desc;
        bubbles.push({ chId: ch.id, text: trunc(line, 34), until: t + 4 });
      }
    }
  }

  // cat
  if (t > cat.pauseUntil) {
    const dx = cat.tx - cat.x, dy = cat.ty - cat.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) {
      cat.tx = 20 + Math.random() * 200;
      cat.ty = 100 + Math.random() * 230;
      cat.pauseUntil = t + 3 + Math.random() * 8;
    } else {
      cat.x += (dx / dist) * 16 * dt;
      cat.y += (dy / dist) * 16 * dt;
      cat.flip = dx < 0;
    }
  }

  particles = particles.filter(p => (p.life -= dt * 0.9) > 0);
  for (const p of particles) p.y += p.vy * dt;
  bubbles = bubbles.filter(b => b.until > t && chars.has(b.chId));
}

function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }
function spawnSparkle(x, y) {
  for (let i = 0; i < 8; i++) particles.push({ x: x + (Math.random() - .5) * 10, y: y + (Math.random() - .5) * 10, vy: -6 - Math.random() * 8, life: 1, hue: 45 });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function px(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

function drawRoom(t) {
  const hour = new Date().getHours();
  const night = hour < 7 || hour >= 18;

  // wall + floor
  px(0, 0, W, WALL_H, '#232741');
  px(0, WALL_H, W, 4, '#1a1d33');
  for (let ty = WALL_H + 4; ty < H; ty += 16) {
    for (let tx = 0; tx < W; tx += 16) {
      px(tx, ty, 16, 16, ((tx + ty) / 16) % 2 ? '#2b2f4e' : '#292d4a');
    }
  }

  // windows
  for (const wx of [24, 96, 168]) {
    px(wx, 10, 44, 34, '#11132a');
    if (night) {
      // stars
      for (let i = 0; i < 6; i++) {
        const sx = wx + 4 + (hashStr(wx + ':' + i) % 36);
        const sy = 14 + (hashStr(i + ':' + wx) % 26);
        const tw = Math.sin(t * 2 + i + wx) > 0 ? '#e8e8ff' : '#777799';
        px(sx, sy, 1, 1, tw);
      }
      px(wx + 30, 16, 6, 6, '#f5f3ce'); // moon
    } else {
      px(wx, 10, 44, 34, '#7ec8e3');
      px(wx + 28, 15, 8, 8, '#ffd76a'); // sun
      px(wx + 6, 22, 12, 4, '#ffffff88');
    }
    px(wx - 2, 8, 48, 2, '#3a3f66'); px(wx - 2, 44, 48, 2, '#3a3f66');
    px(wx - 2, 8, 2, 38, '#3a3f66'); px(wx + 44, 8, 2, 38, '#3a3f66');
    px(wx + 20, 10, 2, 34, '#3a3f66');
  }

  // sign on the wall
  ctx.fillStyle = '#ffd76a';
  ctx.font = '8px monospace';
  ctx.fillText('CLAUDE HQ', 4, 52);

  // lounge rug
  px(24, LOUNGE_TOP + 14, 130, 76, '#41355c');
  px(28, LOUNGE_TOP + 18, 122, 68, '#4b3f6b');

  // couch
  px(34, LOUNGE_TOP + 26, 52, 10, '#8c4f56');
  px(34, LOUNGE_TOP + 20, 52, 8, '#a15e66');
  px(30, LOUNGE_TOP + 20, 6, 18, '#8c4f56');
  px(84, LOUNGE_TOP + 20, 6, 18, '#8c4f56');

  // coffee machine
  px(198, LOUNGE_TOP + 4, 18, 26, '#4a4f7a');
  px(201, LOUNGE_TOP + 8, 12, 8, '#1a1d33');
  px(204, LOUNGE_TOP + 18, 6, 4, '#e8e8f0');
  if (Math.sin(t * 3) > 0.4) px(206, LOUNGE_TOP + 2, 2, 2, '#ffffff55'); // steam

  // plants
  drawPlant(8, LOUNGE_TOP + 6);
  drawPlant(224, DESK_ZONE_TOP - 4);

  // door
  px(DOOR.x - 8, H - 44, 20, 34, '#3a3f66');
  px(DOOR.x - 6, H - 42, 16, 30, '#252945');
  px(DOOR.x + 5, H - 28, 2, 2, '#ffd76a');
}

function drawPlant(x, y) {
  px(x + 2, y + 10, 8, 7, '#8c5a3c');
  px(x + 3, y + 2, 6, 8, '#3f8f4f');
  px(x, y + 4, 4, 5, '#4faf5f');
  px(x + 8, y + 4, 4, 5, '#357f45');
}

function drawDesk(d, occupied, working, t, phase) {
  // desk top + legs
  px(d.x, d.y + 8, DESK_W, 10, '#7a5a3c');
  px(d.x, d.y + 6, DESK_W, 3, '#8f6b47');
  px(d.x + 2, d.y + 18, 3, 5, '#5c422c');
  px(d.x + DESK_W - 5, d.y + 18, 3, 5, '#5c422c');
  // monitor
  const glow = working && Math.sin(t * 7 + phase * 9) > -0.6;
  px(d.x + 9, d.y - 6, 16, 12, '#1a1d33');
  px(d.x + 10, d.y - 5, 14, 10, glow ? '#3fd97f' : '#0f2f1c');
  if (glow) {
    px(d.x + 11, d.y - 3, 8, 1, '#bfffd7');
    px(d.x + 11, d.y - 1, 11, 1, '#bfffd7');
    px(d.x + 11, d.y + 1, 6, 1, '#bfffd7');
  }
  px(d.x + 15, d.y + 6, 4, 2, '#3a3f66');
}

function drawChar(ch, t) {
  const bob = ch.mode === 'walking' ? Math.abs(Math.sin(t * 10 + ch.phase * 6)) * 1.5 : Math.sin(t * 2 + ch.phase * 6) * 0.6;
  const x = ch.x - 6, y = ch.y - 16 - bob;
  const c = ch.col;
  const working = ch.mode === 'desk' && ch.data.status === 'working';

  const oc = ch.data.kind === 'opencode';
  if (oc) {
    // hard hat — contractors, not staff. Amber while running, grey once done.
    const hat = ch.data.running ? '#ffb03a' : '#8a8db0';
    px(x + 1, y - 2, 10, 2, hat);
    px(x + 3, y - 5, 6, 3, hat);
    if (ch.data.stalled && Math.sin(t * 4) > 0) {
      // a running job whose log has gone quiet — flag it, don't hide it
      ctx.fillStyle = '#ff6b6b'; ctx.font = '7px monospace';
      ctx.fillText('!', ch.x + 8, y - 6);
    }
  } else {
    // antenna (blinks while working)
    px(x + 5, y - 3, 2, 3, c.trim);
    px(x + 4, y - 5, 4, 3, working && Math.sin(t * 8 + ch.phase * 9) > 0 ? '#ffd76a' : c.trim);
  }
  // head
  px(x + 2, y, 8, 6, c.body);
  px(x + 3, y + 2, 6, 3, '#11132a');
  const eye = Math.sin(t * 0.9 + ch.phase * 20) > -0.97; // blink
  if (eye) { px(x + (ch.flip ? 3 : 5), y + 3, 1, 1, '#7dffef'); px(x + (ch.flip ? 6 : 8), y + 3, 1, 1, '#7dffef'); }
  // body
  px(x + 1, y + 6, 10, 7, c.body);
  px(x + 1, y + 6, 10, 2, c.trim);
  if (ch.data.kind === 'main') px(x + 5, y + 8, 2, 2, '#ffd76a'); // boss badge
  // arms
  if (working) {
    const j = Math.sin(t * 16 + ch.phase * 30) > 0 ? 1 : 0;
    px(x - 1, y + 8 + j, 2, 3, c.trim);
    px(x + 11, y + 9 - j, 2, 3, c.trim);
  } else if (ch.mode === 'lounge') {
    // coffee cup
    px(x + 11, y + 8, 3, 3, '#e8e8f0');
    if (Math.sin(t * 3 + ch.phase * 9) > 0.2) px(x + 12, y + 5, 1, 2, '#ffffff44');
    px(x - 1, y + 8, 2, 4, c.trim);
  } else {
    px(x - 1, y + 8, 2, 4, c.trim);
    px(x + 11, y + 8, 2, 4, c.trim);
  }
  // legs
  if (ch.mode === 'walking') {
    const s = Math.sin(t * 12 + ch.phase * 6) > 0;
    px(x + 3 + (s ? 0 : 1), y + 13, 2, 3, '#2b2f4e');
    px(x + 7 - (s ? 0 : 1), y + 13, 2, 3, '#2b2f4e');
  } else {
    px(x + 3, y + 13, 2, 3, '#2b2f4e');
    px(x + 7, y + 13, 2, 3, '#2b2f4e');
  }

  // ZZZ for long-idle chillers
  if (ch.mode === 'lounge' && Date.now() - ch.data.lastActive > 10 * 60 * 1000) {
    ctx.fillStyle = '#8ecbff';
    ctx.font = '7px monospace';
    const zp = (t + ch.phase * 4) % 2;
    ctx.fillText('z', ch.x + 7, y - 4 - zp * 3);
    if (zp > 1) ctx.fillText('Z', ch.x + 10, y - 9 - zp * 2);
  }
}

function drawBubbles(t) {
  ctx.font = '7px monospace';
  for (const b of bubbles) {
    const ch = chars.get(b.chId);
    if (!ch) continue;
    const tw = ctx.measureText(b.text).width + 8;
    let bx = Math.min(Math.max(ch.x - tw / 2, 2), W - tw - 2);
    const by = ch.y - 34;
    ctx.fillStyle = 'rgba(240,240,250,.95)';
    ctx.fillRect(bx, by, tw, 12);
    ctx.fillRect(ch.x - 2, by + 12, 4, 3);
    ctx.fillStyle = '#11132a';
    ctx.fillText(b.text, bx + 4, by + 9);
  }
}

function drawCat(t) {
  const x = cat.x - 4, y = cat.y - 5;
  const walking = Math.hypot(cat.tx - cat.x, cat.ty - cat.y) > 2 && t > cat.pauseUntil;
  px(x, y, 8, 4, '#e0a458');
  px(x + (cat.flip ? -2 : 8), y - 2, 3, 4, '#e0a458'); // head
  px(x + (cat.flip ? -2 : 8), y - 3, 1, 1, '#e0a458'); // ear
  px(x + (cat.flip ? 0 : 10), y - 3, 1, 1, '#e0a458');
  const tailUp = Math.sin(t * 4) > 0;
  px(x + (cat.flip ? 8 : -1), y - (tailUp ? 2 : 1), 1, 3, '#c98d45');
  if (walking) {
    const s = Math.sin(t * 10) > 0;
    px(x + 1, y + 4, 1, 2 - (s ? 1 : 0), '#c98d45');
    px(x + 6, y + 4, 1, 2 - (s ? 0 : 1), '#c98d45');
  } else {
    px(x + 1, y + 4, 1, 2, '#c98d45'); px(x + 6, y + 4, 1, 2, '#c98d45');
  }
}

let last = performance.now();
function frame(now) {
  const t = now / 1000;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  step(dt, t);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0e0f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, offX, offY);

  drawRoom(t);
  for (let i = 0; i < DESK_SLOTS.length; i++) {
    const occ = [...chars.values()].find(c => c.deskIdx === i && c.mode === 'desk');
    drawDesk(DESK_SLOTS[i], !!occ, !!occ && occ.data.status === 'working', t, i * 0.37);
  }
  const sorted = [...chars.values()].sort((a, b) => a.y - b.y);
  for (const ch of sorted) drawChar(ch, t);
  drawCat(t);

  for (const p of particles) {
    ctx.fillStyle = `hsla(${p.hue} 80% 70% / ${p.life})`;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1.5, 1.5);
  }
  drawBubbles(t);

  if (chars.size === 0) {
    ctx.fillStyle = '#8a8db0';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText("everyone's gone home 🌙", W / 2, H / 2);
    ctx.textAlign = 'left';
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Tap → character info panel
// ---------------------------------------------------------------------------
const panel = document.getElementById('panel');
document.getElementById('panel-close').addEventListener('click', () => panel.classList.add('hidden'));

canvas.addEventListener('pointerdown', (ev) => {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect(); // canvas may not be at the origin
  const wx = ((ev.clientX - rect.left) * dpr - offX) / scale;
  const wy = ((ev.clientY - rect.top) * dpr - offY) / scale;
  let hit = null, best = 1e9;
  for (const ch of chars.values()) {
    const d = Math.hypot(ch.x - wx, ch.y - 10 - wy);
    if (d < 14 && d < best) { best = d; hit = ch; }
  }
  if (!hit) { panel.classList.add('hidden'); return; }
  const d = hit.data;
  const crown = d.kind === 'main' ? ' 👑' : (d.kind === 'opencode' ? ' 🦺' : '');
  document.getElementById('panel-name').textContent = `${hit.name}${crown}`;
  document.getElementById('panel-type').textContent = `${hit.title} · ${d.stalled ? 'stalled' : d.status}`;
  const line = activityLine(d);
  document.getElementById('panel-desc').textContent =
    line ? `${d.desc || '—'}\n→ ${line}` : (d.desc || '—');
  const ago = Math.round((Date.now() - d.lastActive) / 1000);
  const agoTxt = ago < 90 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
  const meta = [`project: ${d.project}`, `last active ${agoTxt}`];
  if (d.kind === 'opencode') {
    meta.push(`model ${d.model}`, `ran ${fmtElapsed(d.elapsedMs)}`,
      `ctx ${fmtTokens(d.ctxTokens)}`, `log ${d.logKB}KB`);
  }
  document.getElementById('panel-meta').textContent = meta.join(' · ');
  // Clicking a contractor on the floor aims the composer at that agent, so you
  // can talk to one of them directly rather than hunting for its chip.
  if (d.kind === 'opencode' && d.agentName && typeof window.targetAgent === 'function') {
    window.targetAgent(d.agentName);
  }
  panel.classList.remove('hidden');
  if (tg && tg.HapticFeedback) { try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {} }
});
