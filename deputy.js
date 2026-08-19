#!/usr/bin/env node
// The deputy — works a finite, pre-approved queue of OpenCode jobs while Claude
// is at a usage limit, then stops.
//
// Protocol: ~/.claude/LIMIT_HANDOFF_PROTOCOL.md
//
// The design decision this file exists to enforce: the queue is FINITE. When it
// empties, the deputy stops and writes a handoff. It does not look for
// something to do. Its predecessor ran eleven unattended crons, failed 107 of
// 111 runs, and sent 32 junk emails from the mailbox carrying ULC's tender
// proposals. An agent with no work that must produce work invents work.
//
// Run: npm run deputy    (deliberately manual — never a scheduled task)

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JOBS = path.join(os.homedir(), '.opencode-bridge', 'jobs');
const QUEUE = path.join(os.homedir(), '.opencode-bridge', 'queue');
const DONE = path.join(QUEUE, 'done');
const FAILED = path.join(QUEUE, 'failed');
const HANDOFF = path.join(os.homedir(), '.opencode-bridge', 'HANDOFF.md');

const MAX_CONCURRENT = 2;
const STALE_MIN = 12;          // no output for this long => dead
const POLL_MS = 15000;
const MAX_JOB_MIN = 45;        // absolute ceiling per job
const MODEL = 'opencode/deepseek-v4-flash-free';

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

// --------------------------------------------------------------- queue files
function parseQueued(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { error: 'no frontmatter' };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)\s*$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const brief = m[2].trim();
  if (!brief) return { error: 'empty brief' };
  return { meta, brief };
}

function queued() {
  try {
    return fs.readdirSync(QUEUE)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => path.join(QUEUE, f));
  } catch { return []; }
}

// ------------------------------------------------------------- job lifecycle
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function killTree(pid) {
  // Only ever a PID we recorded ourselves. Never sweep by process name — that
  // once took out the parent session's own MCP servers.
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}

function readMeta(jobId) {
  try { return JSON.parse(fs.readFileSync(path.join(JOBS, jobId, 'meta.json'), 'utf8')); }
  catch { return null; }
}

function idleMinutes(jobId) {
  const f = path.join(JOBS, jobId, 'stdout.log');
  try { return (Date.now() - fs.statSync(f).mtimeMs) / 60000; } catch { return Infinity; }
}

function reap() {
  let n = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(JOBS); } catch { return 0; }
  for (const d of dirs) {
    const m = readMeta(d);
    if (!m || m.finished || !pidAlive(m.pid)) continue;
    if (idleMinutes(d) < STALE_MIN) continue;
    killTree(m.pid);
    m.state = 'failed';
    m.finished = new Date().toISOString();
    m.failure_reason = `Reaped by deputy: silent for over ${STALE_MIN} minutes.`;
    try { fs.writeFileSync(path.join(JOBS, d, 'meta.json'), JSON.stringify(m, null, 2)); } catch {}
    log(`reaped ${d} (pid ${m.pid})`);
    n++;
  }
  return n;
}

function runningCount() {
  let n = 0;
  try {
    for (const d of fs.readdirSync(JOBS)) {
      const m = readMeta(d);
      if (m && !m.finished && pidAlive(m.pid)) n++;
    }
  } catch {}
  return n;
}

function dispatch({ meta, brief }) {
  const cwd = meta.cwd || path.join(os.homedir(), 'OneDrive', 'Desktop', 'ULC');
  if (!fs.existsSync(cwd)) return { error: `cwd missing: ${cwd}` };

  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const jobId = `oc-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const jd = path.join(JOBS, jobId);
  fs.mkdirSync(jd, { recursive: true });
  fs.writeFileSync(path.join(jd, 'brief.md'), brief, 'utf8');

  const out = fs.openSync(path.join(jd, 'stdout.log'), 'a');
  const err = fs.openSync(path.join(jd, 'stderr.log'), 'a');
  const args = ['run', '--format', 'json', '--dir', cwd, '--model', MODEL];
  if (meta.agent) args.push('--agent', meta.agent);
  args.push(brief);

  let child;
  try {
    child = spawn('opencode', args, { detached: true, stdio: ['ignore', out, err], shell: true });
  } catch (e) { return { error: 'spawn failed: ' + e.message }; }
  child.unref();

  const expect = meta.expect_file
    ? (path.isAbsolute(meta.expect_file) ? meta.expect_file : path.join(cwd, meta.expect_file))
    : null;

  fs.writeFileSync(path.join(jd, 'meta.json'), JSON.stringify({
    job_id: jobId, label: meta.label || jobId, pid: child.pid, cwd,
    model: MODEL, agent: meta.agent || '', command: '',
    expect_file: expect, started: new Date().toISOString(),
    finished: null, state: 'running', dispatched_from: 'deputy',
  }, null, 2));

  return { jobId, expect };
}

// The deliverable is the ground truth. Tokens are not output.
function verdict(jobId, expect) {
  if (!expect) return { ok: true, note: 'no expect_file declared — unverified' };
  if (!fs.existsSync(expect)) return { ok: false, note: `NO_OUTPUT — ${path.basename(expect)} was never written` };
  const size = fs.statSync(expect).size;
  if (size < 200) return { ok: false, note: `NO_OUTPUT — ${path.basename(expect)} is a ${size}-byte stub` };
  let text = '';
  try { text = fs.readFileSync(expect, 'utf8'); } catch {}
  const holes = (text.match(/\[PENDING\]|\[TODO\]|<placeholder>/g) || []).length;
  if (holes >= 3 || (holes && size < 4000)) {
    return { ok: false, note: `SCAFFOLD_ONLY — headings written, ${holes} placeholders left unfilled` };
  }
  return { ok: true, note: `${Math.round(size / 1024)}KB` };
}

function waitFor(jobId) {
  return new Promise(resolve => {
    const started = Date.now();
    const tick = setInterval(() => {
      const m = readMeta(jobId);
      const mins = (Date.now() - started) / 60000;
      if (!m || (!pidAlive(m.pid) && m)) { clearInterval(tick); return resolve('exited'); }
      if (idleMinutes(jobId) >= STALE_MIN) { killTree(m.pid); clearInterval(tick); return resolve('stalled'); }
      if (mins >= MAX_JOB_MIN) { killTree(m.pid); clearInterval(tick); return resolve('timeout'); }
    }, POLL_MS);
  });
}

// ------------------------------------------------------------------- handoff
function writeHandoff(results, started) {
  const lines = [
    '# Deputy handoff',
    '',
    `Run started ${started.toLocaleString()}, finished ${new Date().toLocaleString()}.`,
    '',
    '**Claude: read this before anything else after a limit break.**',
    '',
    '## What landed', '',
  ];
  const ok = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);
  if (!ok.length) lines.push('_Nothing._', '');
  for (const r of ok) lines.push(`- **${r.label}** — \`${r.expect || '(no declared output)'}\` — ${r.note}`);
  lines.push('', '## What failed', '');
  if (!bad.length) lines.push('_Nothing._', '');
  for (const r of bad) {
    lines.push(`- **${r.label}** — ${r.note}${r.retried ? ' (retried once)' : ''}`);
    lines.push(`  - brief preserved at \`${r.queueFile}\``);
  }
  const left = queued();
  lines.push('', '## Still queued', '');
  lines.push(left.length ? left.map(f => `- ${path.basename(f)}`).join('\n') : '_Queue is empty._');
  lines.push('', '## Needs a human', '');
  lines.push('- Every draft produced above is unsent and unapproved. Nothing left the building.');
  lines.push('- Verify any finding before acting on it: a finished job is not a delivered job.');
  lines.push('');
  fs.writeFileSync(HANDOFF, lines.join('\n'), 'utf8');
  log(`handoff written -> ${HANDOFF}`);
}

// ---------------------------------------------------------------------- main
(async function main() {
  const started = new Date();
  for (const d of [QUEUE, DONE, FAILED]) fs.mkdirSync(d, { recursive: true });

  console.log('');
  console.log('  ┌──────────────────────────────────────┐');
  console.log('  │  DEPUTY — working the approved queue │');
  console.log('  └──────────────────────────────────────┘');

  reap();

  const results = [];
  let file;
  while ((file = queued()[0])) {
    const parsed = parseQueued(file);
    const label = path.basename(file);
    if (parsed.error) {
      log(`SKIP ${label}: ${parsed.error}`);
      fs.renameSync(file, path.join(FAILED, path.basename(file)));
      results.push({ label, ok: false, note: parsed.error, queueFile: path.join(FAILED, path.basename(file)) });
      continue;
    }

    while (runningCount() >= MAX_CONCURRENT) {
      log(`cap reached (${MAX_CONCURRENT}) — waiting`);
      await new Promise(r => setTimeout(r, POLL_MS));
      reap();
    }

    let attempt = 0, res = null, v = null;
    while (attempt < 2) {
      attempt++;
      log(`dispatch ${label}${attempt > 1 ? ' (retry)' : ''}${parsed.meta.agent ? ' as ' + parsed.meta.agent : ''}`);
      res = dispatch(parsed);
      if (res.error) { v = { ok: false, note: res.error }; break; }
      const how = await waitFor(res.jobId);
      v = verdict(res.jobId, res.expect);
      log(`  ${res.jobId} ${how} -> ${v.ok ? 'OK' : 'FAILED'} (${v.note})`);
      // Retry once: these signatures are provider failures, not bad briefs.
      // Re-dispatch the SAME brief — never rewrite it for a fault it didn't cause.
      if (v.ok) break;
    }

    const dest = path.join(v.ok ? DONE : FAILED, path.basename(file));
    fs.renameSync(file, dest);
    results.push({ label: parsed.meta.label || label, ok: v.ok, note: v.note,
                   expect: res && res.expect, retried: attempt > 1, queueFile: dest });
  }

  log('queue empty — stopping');
  writeHandoff(results, started);
  console.log('');
  console.log(`  ${results.filter(r => r.ok).length} delivered, ${results.filter(r => !r.ok).length} failed.`);
  console.log('  The deputy does not look for more work. That is deliberate.');
  console.log('');
})();
