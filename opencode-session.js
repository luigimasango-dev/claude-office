// opencode-session.js - how the office starts an OpenCode v2 job in the right directory.
//
// v2 (2026-09-27) removed `run --dir`, ignores the process cwd, and a trailing
// directory after the message is NOT a positional: it is appended to the prompt text
// and the session still opens in HOME (measured in the session DB). The only route
// that pins the working directory is session.create with a location, then
// `run --session <id>`. Same mechanism as the Python bridge (opencode-bridge-mcp).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The real binary, never the npm .cmd shim and never shell:true (a shim/shell leaves a
// grandchild that survives a timeout kill, and shell:true lets & | > ^ " split a brief).
const _EXE = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
const OPENCODE_EXE = fs.existsSync(_EXE) ? _EXE : 'opencode';

// Throws instead of falling back, so a job never runs silently in the wrong directory.
function createSession(cwd) {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`working directory does not exist: ${cwd}`); // v2 accepts a location that does not exist
  }
  const body = JSON.stringify({ location: { directory: cwd } });
  let out;
  try {
    out = execFileSync(OPENCODE_EXE, ['api', 'POST', '/api/session', '-H', 'content-type:application/json', '-d', body],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    throw new Error(`session.create failed: ${String((e.stdout || '') + (e.stderr || '') || e.message).trim().slice(0, 300)}`);
  }
  const m = /"id"\s*:\s*"(ses_[A-Za-z0-9]+)"/.exec(out || '');
  if (!m) throw new Error(`session.create returned no id: ${String(out).trim().slice(0, 300)}`);
  return m[1];
}

// `opencode run` argv: message first, then flags, `--file` last (it is greedy).
function runArgs({ sessionId, message, model, agent, attach }) {
  const args = ['run', message, '--session', sessionId, '--format', 'json', '--model', model];
  if (agent) args.push('--agent', agent);
  if (attach) args.push('--file', attach);
  return args;
}

module.exports = { OPENCODE_EXE, createSession, runArgs };
