// Regression test for issue #2: OpenCode contractor count reads 0.
//
// Cause: scanOpencode() read ~/.opencode-bridge/jobs, a directory that died
// with the bridge on 2026-08-20, so it returned [] forever. The fix reads live
// sessions from OpenCode's SQLite store (table `session`).
//
// Headless-safe: builds a scratch db (one working, one chilling, one
// long-gone session), points the real server at it via OPENCODE_DB, and
// asserts /api/state shows the right contractors. FAILS on the pre-fix server
// (contractors always []), PASSES with the fix.
//
// Run: node test/opencode_scan.mjs  (exit 0 = pass)

import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.SCAN_TEST_PORT || 18737);
const REPO_ROOT = path.join(import.meta.dirname, "..");

function get(pathname, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("http timeout")); });
  });
}

async function waitForApi(child) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await get("/api/state");
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error("server exited before serving (code " + child.exitCode + ")");
    if (Date.now() - start > 15000) throw new Error("server did not serve /api/state within 15s");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  // Refuse against a live server — results would be ambiguous.
  try {
    await get("/api/state");
    throw new Error(`port ${PORT} already serves (stop it first)`);
  } catch (e) {
    if (!/ECONNREFUSED|timeout/.test(e.message)) throw e;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-scan-"));
  const dbPath = path.join(tmp, "opencode.db");
  const now = Date.now();
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)");
  const ins = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("ses_working1", "C:/Dev/demo", "Live contractor work", "build",
    JSON.stringify({ id: "opencode/deepseek-v4-flash-free", providerID: "opencode" }), now - 60000, now);
  ins.run("ses_chilling1", "C:/Dev/old", "Earlier today", "plan",
    JSON.stringify({ id: "nvidia/nemotron-3.5-lightning-30b-a3b", providerID: "nvidia" }), now - 3600000, now - 10 * 60 * 1000);
  ins.run("ses_gone1", "C:/Dev/old", "Yesterday", "build", null, now - 7200000, now - 60 * 60 * 1000);
  db.close();

  const child = spawn(process.execPath, ["server.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), OPENCODE_DB: dbPath, NO_TUNNEL: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const kill = () => { try { child.kill(); } catch (_) {} };

  try {
    await waitForApi(child);
    const { body } = await get("/api/state");
    const state = JSON.parse(body);
    const oc = state.characters.filter((c) => c.kind === "opencode");
    console.log(`contractors on floor: ${oc.length} (roster ${state.characters.length})`);

    const fail = (m) => { throw new Error(m + " — got: " + JSON.stringify(oc.map((c) => ({ id: c.id, status: c.status, running: c.running })))); };
    if (oc.length !== 2) fail(`expected 2 contractors (working + chilling), saw ${oc.length} — count bug present`);

    const w = oc.find((c) => c.id === "ses_working1");
    if (!w) fail("fresh session missing from roster");
    if (w.status !== "working" || w.running !== true) fail("fresh session not working/running");
    if (w.model !== "deepseek-v4-flash-free") fail("model id not parsed (want deepseek-v4-flash-free, saw " + w.model + ")");
    if (w.project !== "demo") fail("project basename wrong (saw " + w.project + ")");
    console.log("phase 1 PASS: fresh session is a running contractor with parsed model");

    const ch = oc.find((c) => c.id === "ses_chilling1");
    if (!ch) fail("10-min-old session missing (should chill)");
    if (ch.status !== "chilling" || ch.running !== false) fail("10-min-old session not chilling");
    console.log("phase 2 PASS: 10-min-old session chills, hour-old session gone home");

    console.log("opencode_scan PASS (issue #2 regression covered)");
  } finally {
    kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error("opencode_scan FAIL:", e.message); process.exit(1); },
);
