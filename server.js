// Claude HQ — live office dashboard server
// Zero-dependency Node server: scans ~/.claude/projects for live session +
// subagent activity, serves the Mini App frontend, streams state via SSE,
// spawns a Cloudflare quick tunnel and points the Telegram bot's menu
// button at it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8737;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OPENCODE_JOBS_DIR = path.join(os.homedir(), '.opencode-bridge', 'jobs');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Activity thresholds (ms since last file write)
const WORKING_MS = 2 * 60 * 1000;   // touched in last 2 min  -> working
const CHILLING_MS = 30 * 60 * 1000; // touched in last 30 min -> chilling
// older than CHILLING_MS -> gone home (not shown)

// ---------------------------------------------------------------------------
// .env loader (no deps)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env yet — fine */ }
}
loadEnv();

// Sessions pinned to the board regardless of age (PINNED_SESSIONS in .env,
// comma-separated UUIDs). Lets a finished session stay visible for review.
// Built AFTER loadEnv() — building it at module top read an empty process.env.
const PINNED = new Set(
  (process.env.PINNED_SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// ---------------------------------------------------------------------------
// Scanner: ~/.claude/projects -> roster of characters
// ---------------------------------------------------------------------------
const headCache = new Map(); // sessionFilePath -> {title, cwd}

function readSessionHead(file) {
  if (headCache.has(file)) return headCache.get(file);
  const info = { title: null, cwd: null };
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n');
    for (const line of lines.slice(0, 20)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (!info.cwd && typeof j.cwd === 'string') info.cwd = j.cwd;
        if (!info.title && j.type === 'summary' && typeof j.summary === 'string') info.title = j.summary;
      } catch { /* partial last line in buffer — ignore */ }
      if (info.cwd && info.title) break;
    }
  } catch { /* unreadable — ignore */ }
  headCache.set(file, info);
  return info;
}

function statusFor(ageMs) {
  if (ageMs < WORKING_MS) return 'working';
  if (ageMs < CHILLING_MS) return 'chilling';
  return null; // gone home
}

// ---------------------------------------------------------------------------
// Live activity: what is each character actually doing right now?
//
// Both Claude transcripts and OpenCode job logs are append-only NDJSON, so the
// last few KB hold the current action. We read a tail rather than the whole
// file — an OpenCode run's stdout.log passes 500KB in minutes and this is
// re-read every 3 seconds.
// ---------------------------------------------------------------------------
const activityCache = new Map(); // file -> { mtimeMs, size, value }

function readTail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
}

// Re-parse only when the file has actually changed since last scan.
function cachedActivity(file, bytes, parse) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const hit = activityCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = parse(readTail(file, bytes), st);
  activityCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// These strings go out over SSE every few seconds and are only ever rendered
// as a one-line label, so they get clipped here rather than at the far end —
// an assistant turn or a heredoc command can run to thousands of characters.
const LABEL_MAX = 120;
function clip(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 1) + '…' : t;
}

// Pull the most interesting scrap of a tool call's input for a one-line label.
function shortInput(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['command', 'file_path', 'filePath', 'pattern', 'query', 'path', 'url', 'prompt', 'skill', 'subject']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(v);
  }
  return null;
}

// A Claude session/subagent transcript: last tool_use, else last assistant text.
function parseClaudeActivity(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const content = j.message && j.message.content;
    if (!Array.isArray(content)) continue;
    for (let k = content.length - 1; k >= 0; k--) {
      const c = content[k];
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use') return { tool: c.name || 'tool', detail: shortInput(c.input) };
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        return { tool: null, detail: clip(c.text) };
      }
    }
  }
  return null;
}

// An OpenCode job's stdout.log: last tool call, latest context size, last text.
function parseOpencodeActivity(text, st) {
  const out = { tool: null, detail: null, ctxTokens: 0, say: null, logKB: Math.round(st.size / 1024) };
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.tool && out.ctxTokens && out.say) break;
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const part = j.part || {};
    if (!out.ctxTokens && j.type === 'step_finish' && part.tokens && part.tokens.total) {
      out.ctxTokens = part.tokens.total;
    }
    if (!out.tool && j.type === 'tool_use') {
      out.tool = part.tool || 'tool';
      const state = part.state || {};
      out.detail = clip(state.title) || shortInput(state.input);
    }
    if (!out.say && j.type === 'text' && typeof part.text === 'string') {
      out.say = clip(part.text);
    }
  }
  return out;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// Scanner: ~/.opencode-bridge/jobs -> OpenCode contractors on the floor
// ---------------------------------------------------------------------------
function scanOpencode(now) {
  const chars = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(OPENCODE_JOBS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return chars; } // bridge not installed — fine, no contractors today

  for (const jobId of dirs) {
    const jobDir = path.join(OPENCODE_JOBS_DIR, jobId);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8')); } catch { continue; }

    const logFile = path.join(jobDir, 'stdout.log');
    let logStat = null;
    try { logStat = fs.statSync(logFile); } catch { /* no output yet */ }

    // A job counts as running only if the bridge left it open AND its process
    // is genuinely alive. A dead pid with no finish stamp is a crashed run, and
    // the 4 Aug ghost-run bug is exactly why we don't trust the state field.
    const running = !meta.finished && pidAlive(meta.pid);

    let status;
    if (running) {
      status = 'working';
    } else {
      const endedAt = meta.finished ? Date.parse(meta.finished)
        : (logStat ? logStat.mtimeMs : Date.parse(meta.started));
      status = statusFor(now - endedAt);
      if (status === 'working') status = 'chilling'; // finished work isn't work
    }
    if (!status) continue; // knocked off long ago

    const act = logStat ? cachedActivity(logFile, 96 * 1024, parseOpencodeActivity) : null;
    const startedMs = Date.parse(meta.started) || now;

    // A running job whose log has gone quiet for 3 minutes is worth seeing.
    const stalled = running && logStat ? (now - logStat.mtimeMs) > 3 * 60 * 1000 : false;

    chars.push({
      id: jobId,
      kind: 'opencode',
      agentType: 'opencode',
      name: null,                        // frontend assigns a deterministic name
      project: meta.cwd ? path.basename(meta.cwd) : 'opencode',
      desc: meta.label || 'OpenCode job',
      status,
      lastActive: logStat ? logStat.mtimeMs : startedMs,
      jobId,
      model: (meta.model || '').replace(/^opencode\//, '') || 'unknown',
      agentName: meta.agent || '',   // lets the composer aim at this contractor
      running,
      stalled,
      elapsedMs: (meta.finished ? Date.parse(meta.finished) : now) - startedMs,
      activity: act ? { tool: act.tool, detail: act.detail, say: act.say } : null,
      ctxTokens: act ? act.ctxTokens : 0,
      logKB: act ? act.logKB : 0,
    });
  }
  return chars;
}

function scan() {
  const now = Date.now();
  const chars = [];
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return { generatedAt: now, characters: [], error: 'projects dir not found' };
  }

  for (const proj of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, proj);
    let entries;
    try { entries = fs.readdirSync(projPath, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      // Main session transcript: <uuid>.jsonl
      if (e.isFile() && /^[0-9a-f-]{36}\.jsonl$/.test(e.name)) {
        const file = path.join(projPath, e.name);
        const sid = e.name.replace('.jsonl', '');
        let st; try { st = fs.statSync(file); } catch { continue; }
        const status = statusFor(now - st.mtimeMs);
        const pinned = PINNED.has(sid);
        // A pinned session is never "gone home" — hold it on the board as chilling.
        const shown = pinned ? (status || 'chilling') : status;
        if (!shown) continue;
        const head = readSessionHead(file);
        const projectLabel = head.cwd ? path.basename(head.cwd) : proj.split('-').filter(Boolean).slice(-1)[0];
        chars.push({
          id: sid, kind: 'main', agentType: 'claude',
          name: 'Claude', project: projectLabel,
          desc: head.title || `Session in ${projectLabel}`,
          status: shown, lastActive: st.mtimeMs, sessionId: sid, pinned,
          activity: cachedActivity(file, 64 * 1024, parseClaudeActivity),
        });

        // Subagents for this session
        const subDir = path.join(projPath, sid, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')); } catch { /* none */ }
        for (const sf of subs) {
          const sfile = path.join(subDir, sf);
          let sst; try { sst = fs.statSync(sfile); } catch { continue; }
          const sstatus = statusFor(now - sst.mtimeMs);
          if (!sstatus) continue;
          const aid = sf.replace('.jsonl', '');
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(subDir, aid + '.meta.json'), 'utf8')); } catch { /* fine */ }
          chars.push({
            id: `${sid}:${aid}`, kind: 'sub',
            agentType: meta.agentType || 'general-purpose',
            name: null, // frontend assigns a fun deterministic name
            project: projectLabel,
            desc: meta.description || 'On a mission',
            status: sstatus, lastActive: sst.mtimeMs,
            sessionId: sid, parentId: meta.parentAgentId || null,
            spawnDepth: meta.spawnDepth || 1,
            activity: cachedActivity(sfile, 64 * 1024, parseClaudeActivity),
          });
        }
      }
    }
  }

  for (const oc of scanOpencode(now)) chars.push(oc);

  chars.sort((a, b) => a.id.localeCompare(b.id)); // stable desk assignment
  return { generatedAt: now, characters: chars, queued: queueDepth() };
}

// ---------------------------------------------------------------------------
// HTTP server: static files + /api/state + /events (SSE)
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const sseClients = new Set();
let lastStateJson = '';

// ---------------------------------------------------------------------------
// POST /dispatch — hire a contractor from the dashboard
//
// Mirrors the Python bridge's contract exactly (same job dir layout, same
// meta.json, same inline-prompt form) so a job dispatched from here is
// indistinguishable from one Claude dispatched, and shows up on the floor the
// same way. The brief goes INLINE rather than as "read this file": a detached
// run asked to read a path outside its working directory hits a permission
// check nobody is there to answer, and an unanswered ask resolves to DENY.
// ---------------------------------------------------------------------------
const ALLOWED_ROOTS = [
  path.join(os.homedir(), 'OneDrive', 'Desktop', 'ULC'),
  'C:\\Trading',
  'C:\\Dev',
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
];

function withinAllowed(p) {
  const rp = path.resolve(p).toLowerCase();
  return ALLOWED_ROOTS.some(r => rp.startsWith(path.resolve(r).toLowerCase()));
}

function countRunning() {
  let n = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(OPENCODE_JOBS_DIR); } catch { return 0; }
  for (const d of dirs) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(OPENCODE_JOBS_DIR, d, 'meta.json'), 'utf8'));
      if (!m.finished && pidAlive(m.pid)) n++;
    } catch { /* skip */ }
  }
  return n;
}

const MAX_CONCURRENT = 2;

// ---------------------------------------------------------------------------
// The queue sits between the composer and the concurrency cap.
//
// "Run them all at once" and "never more than 2 concurrent" are both true: you
// fire a brief at ten agents, all ten are accepted immediately, and the drainer
// releases them two at a time. Four at once took the whole fleet down on
// 2026-08-04, so the cap is not negotiable — but the user should never have to
// think about it.
//
// Same directory the deputy drains, so a job queued from the dashboard survives
// the dashboard being closed.
// ---------------------------------------------------------------------------
const QUEUE_DIR = path.join(os.homedir(), '.opencode-bridge', 'queue');

function enqueue({ brief, agent, cwd, label }) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const slug = (agent || 'default').replace(/[^a-z0-9-]/gi, '');
  const file = path.join(QUEUE_DIR, `${stamp}-${slug}-${Math.random().toString(16).slice(2, 6)}.md`);
  const fm = [
    '---',
    `agent: ${agent || ''}`,
    `cwd: ${cwd || path.join(os.homedir(), 'OneDrive', 'Desktop', 'ULC')}`,
    `label: ${(label || brief.split('\n')[0]).slice(0, 60)}`,
    '---',
    '',
    brief,
    '',
  ].join('\n');
  fs.writeFileSync(file, fm, 'utf8');
  return path.basename(file);
}

function queueDepth() {
  // Top level only — `failed/` and `inflight/` are subdirectories, so their
  // contents never re-enter the queue. readdirSync is non-recursive, which is
  // what makes that true; do not "improve" it into a recursive walk.
  try { return fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.md')).length; }
  catch { return 0; }
}

// A drainer crash takes the whole dashboard down with it, and on 2026-08-04 it
// did exactly that. Nothing in a background timer is worth losing the server.
function safeDrain() {
  try { drainQueue(); }
  catch (e) { console.log('  ! drainQueue error (server stays up):', e.message); }
}

function drainQueue() {
  if (queueDepth() === 0) return;
  let slots = MAX_CONCURRENT - countRunning();
  if (slots <= 0) return;
  const failedDir = path.join(QUEUE_DIR, 'failed');
  const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.md')).sort();
  for (const f of files) {
    if (slots <= 0) break;
    const full = path.join(QUEUE_DIR, f);
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    // PowerShell's Set-Content -Encoding utf8 writes a BOM, and a leading
    // ﻿ stops /^---/ matching. Observed 2026-08-04: five hand-queued jobs
    // all "failed to parse" for this reason alone.
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!m) {
      // Move it OUT of the queue, do not rename in place. Renaming in place
      // left the file matching *.md, so the drainer re-read it every 8 seconds
      // and prefixed "failed-" again each time — filenames grew without bound.
      try {
        fs.mkdirSync(failedDir, { recursive: true });
        fs.renameSync(full, path.join(failedDir, f.replace(/^(failed-)+/, '')));
      } catch { /* leave it; next pass will retry */ }
      continue;
    }
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)\s*$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    // Claim the file by MOVING it out of the queue, never by deleting it.
    //
    // The first version unlinked before dispatching, to stop a failing job
    // spinning the drainer. It also meant a spawn failure destroyed the brief:
    // on 2026-08-04 two queued debate seats vanished with no job created and
    // nothing on disk to show they had ever existed. A claimed job that fails
    // must still be recoverable.
    const inflightDir = path.join(QUEUE_DIR, 'inflight');
    const claimed = path.join(inflightDir, f);
    try {
      fs.mkdirSync(inflightDir, { recursive: true });
      fs.renameSync(full, claimed);
    } catch { continue; }

    dispatch({ brief: m[2].trim(), agent: meta.agent, cwd: meta.cwd, label: meta.label }, r => {
      if (r.error) {
        console.log(`  ! queue dispatch failed: ${r.error}`);
        try {
          fs.mkdirSync(failedDir, { recursive: true });
          fs.renameSync(claimed, path.join(failedDir, f));
        } catch { /* it stays in inflight; still recoverable by hand */ }
      } else {
        console.log(`  ✦ released from queue: ${meta.label || f}`);
        try { fs.unlinkSync(claimed); } catch { /* harmless */ }
      }
    });
    slots--;
  }
}
setInterval(safeDrain, 8000);

// Same reasoning for the whole process: a background failure should be logged,
// not fatal. The dashboard is the thing that keeps working when Claude does not.
process.on('uncaughtException', e => console.log('! uncaught (server stays up):', e.message));
process.on('unhandledRejection', e => console.log('! unhandled rejection:', e && e.message));

function dispatch({ brief, agent, cwd, label }, cb) {
  if (!brief || !brief.trim()) return cb({ error: 'Empty brief.' });
  const work = cwd && cwd.trim() ? cwd.trim() : path.join(os.homedir(), 'OneDrive', 'Desktop', 'ULC');
  if (!fs.existsSync(work)) return cb({ error: `Working directory does not exist: ${work}` });
  if (!withinAllowed(work)) return cb({ error: `Refusing to run in ${work} — outside the allowed roots.` });

  const running = countRunning();
  if (running >= MAX_CONCURRENT) {
    return cb({ error: `${running} job(s) already running (cap ${MAX_CONCURRENT}). Four at once took the whole fleet down on 4 Aug — wait for a slot.` });
  }

  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const jobId = `oc-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const jd = path.join(OPENCODE_JOBS_DIR, jobId);

  try { fs.mkdirSync(jd, { recursive: true }); } catch (e) { return cb({ error: 'Could not create job dir: ' + e.message }); }
  fs.writeFileSync(path.join(jd, 'brief.md'), brief, 'utf8');

  const out = fs.openSync(path.join(jd, 'stdout.log'), 'a');
  const err = fs.openSync(path.join(jd, 'stderr.log'), 'a');

  const args = ['run', '--format', 'json', '--dir', work, '--model', 'opencode/deepseek-v4-flash-free'];
  if (agent && agent.trim()) args.push('--agent', agent.trim());
  args.push(brief);

  let child;
  try {
    child = spawn('opencode', args, { detached: true, stdio: ['ignore', out, err], shell: true });
  } catch (e) {
    return cb({ error: 'Could not spawn opencode: ' + e.message });
  }
  child.unref();

  fs.writeFileSync(path.join(jd, 'meta.json'), JSON.stringify({
    job_id: jobId,
    label: label && label.trim() ? label.trim() : brief.trim().split('\n')[0].slice(0, 80),
    pid: child.pid,
    cwd: work,
    model: 'opencode/deepseek-v4-flash-free',
    agent: agent || '',
    command: '',
    expect_file: null,
    started: new Date().toISOString().replace('Z', '+00:00'),
    finished: null,
    state: 'running',
    dispatched_from: 'dashboard',
  }, null, 2), 'utf8');

  cb({ ok: true, jobId, pid: child.pid, cwd: work, agent: agent || '(default)' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/dispatch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = null; }
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (!payload) return send({ error: 'Bad JSON.' }, 400);

      const brief = (payload.brief || '').trim();
      if (!brief) return send({ error: 'Empty brief.' }, 400);

      // `agents` (array) is the fan-out form; `agent` (string) the single form.
      const targets = Array.isArray(payload.agents) && payload.agents.length
        ? payload.agents
        : [payload.agent || ''];

      const cwd = (payload.cwd || '').trim() || path.join(os.homedir(), 'OneDrive', 'Desktop', 'ULC');
      if (!fs.existsSync(cwd)) return send({ error: `Working directory does not exist: ${cwd}` }, 400);
      if (!withinAllowed(cwd)) return send({ error: `Refusing to run in ${cwd} — outside the allowed roots.` }, 400);

      // One target and a free slot: run it now so a single ask feels instant.
      if (targets.length === 1 && countRunning() < MAX_CONCURRENT) {
        return dispatch({ brief, agent: targets[0], cwd, label: payload.label },
                        r => send(r, r.error ? 400 : 200));
      }

      // Otherwise queue everything and let the drainer release two at a time.
      const queuedNames = targets.map(a => enqueue({
        brief, agent: a, cwd,
        label: `${a || 'default'} — ${(payload.label || brief.split('\n')[0]).slice(0, 48)}`,
      }));
      drainQueue();
      send({
        ok: true, queued: queuedNames.length, depth: queueDepth(),
        agents: targets.map(a => a || 'default'),
      });
    });
    return;
  }

  if (url.pathname === '/api/agents') {
    // Roster for the composer's dropdown, read from the agent definitions.
    const dir = path.join(os.homedir(), '.config', 'opencode', 'agent');
    let names = [];
    try {
      names = fs.readdirSync(dir)
        .filter(f => f.endsWith('.md') && f !== 'README.md')
        .map(f => f.replace(/\.md$/, ''))
        .sort();
    } catch { /* none yet */ }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ agents: names }));
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(scan()));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(scan())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Static. `/` is the Telegram Mini App (the bot menu button points at it);
  // `/dash` is the desktop control room for a normal browser.
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p === '/dash' || p === '/dash/') p = '/dash.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// Broadcast state to SSE clients every 3s (only when changed, heartbeat every 20s)
let lastBeat = 0;
setInterval(() => {
  if (sseClients.size === 0) return;
  const state = scan();
  const json = JSON.stringify(state);
  const changed = stripTime(json) !== stripTime(lastStateJson);
  const beat = Date.now() - lastBeat > 20000;
  if (!changed && !beat) return;
  lastStateJson = json;
  lastBeat = Date.now();
  for (const c of sseClients) c.write(`data: ${json}\n\n`);
}, 3000);

// elapsedMs ticks up every scan for a running job; ignore it when deciding
// whether anything meaningful changed, or every tick becomes a broadcast.
function stripTime(j) {
  return j.replace(/"generatedAt":\d+/, '')
    .replace(/"lastActive":\d+(\.\d+)?/g, '')
    .replace(/"elapsedMs":\d+/g, '');
}

// ---------------------------------------------------------------------------
// Cloudflare quick tunnel + Telegram menu button wiring
// ---------------------------------------------------------------------------
function findCloudflared() {
  const local = path.join(__dirname, 'cloudflared.exe');
  if (fs.existsSync(local)) return local;
  return 'cloudflared'; // hope it's on PATH
}

function startTunnel() {
  const bin = findCloudflared();
  let proc;
  try {
    proc = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.log('! Could not start cloudflared:', e.message);
    return;
  }
  let found = false;
  const onData = (buf) => {
    const s = buf.toString();
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !found) {
      found = true;
      console.log('');
      console.log('  ✦ Public URL:', m[0]);
      console.log('');
      wireTelegram(m[0]);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => console.log(`! cloudflared exited (${code})`));
  process.on('exit', () => { try { proc.kill(); } catch {} });
}

async function wireTelegram(publicUrl) {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log('  (no BOT_TOKEN in .env — set it to auto-wire the bot menu button)');
    console.log('  Or set it manually in @BotFather: Bot Settings → Menu Button →', publicUrl);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: '🏢 Claude HQ', web_app: { url: publicUrl } } }),
    });
    const j = await r.json();
    if (j.ok) console.log('  ✦ Bot menu button updated → open your bot in Telegram and tap "🏢 Claude HQ"');
    else console.log('  ! Telegram API error:', JSON.stringify(j));
  } catch (e) {
    console.log('  ! Failed to reach Telegram API:', e.message);
  }
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────┐');
  console.log('  │  🏢 Claude HQ — live office server   │');
  console.log('  └─────────────────────────────────────┘');
  console.log(`  Dashboard: http://localhost:${PORT}/dash   <- open this in Chrome`);
  console.log(`  Mini App:  http://localhost:${PORT}/       (Telegram layout)`);
  const s = scan();
  const oc = s.characters.filter(c => c.kind === 'opencode').length;
  console.log(`  Roster right now: ${s.characters.length} character(s) on the floor (${oc} from OpenCode)`);
  if (process.env.OPEN_BROWSER === '1') {
    try { spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}/dash`], { detached: true, stdio: 'ignore' }).unref(); } catch { /* open it yourself then */ }
  }
  if (process.env.NO_TUNNEL !== '1') startTunnel();
});
