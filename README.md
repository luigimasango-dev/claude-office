# 🏢 Claude HQ

A Telegram Mini App that renders a live pixel-art office of your Claude Code
sessions **and your OpenCode jobs**. Every active session is a Claude at a
desk; every subagent is a robot coworker; every OpenCode run is a **contractor
in a hard hat**. Agents actively working type at a glowing monitor;
recently-idle ones are **chilling** in the lounge with coffee; after 30 minutes
of silence they walk out the door. Tap anyone to see what they're doing.
There is also a cat. The cat answers to no one.

## How it works

- `server.js` (zero npm dependencies) scans two sources every 3s:
  - `~/.claude/projects/**` — session and subagent `.jsonl` transcripts
  - `~/.opencode-bridge/jobs/**` — OpenCode job `meta.json` + `stdout.log`
- File mtimes drive status:
  - touched < 2 min ago → **working**
  - touched < 30 min ago → **chilling**
  - older → gone home
- **Live activity.** Both transcript formats are append-only NDJSON, so the
  server reads the last 64–96KB of each active file and pulls out the current
  tool call. That becomes the speech bubble — a new bubble fires the moment the
  action changes, so you watch `bash: pdftotext …` turn into `write: report.md`
  in real time. Labels are clipped to 120 chars server-side; an assistant turn
  or a heredoc would otherwise put kilobytes on the wire every 3 seconds.
- **OpenCode specifics.** Contractors carry an amber hard hat while running,
  grey once done. Tapping one shows model, elapsed time, context size and log
  volume. A job is only "running" if the bridge left it open *and* its pid is
  genuinely alive — a dead pid with no finish stamp is a crashed run, not a
  working one. A running job whose log has been silent for 3 minutes gets a red
  `!` over its head rather than quietly looking busy.
- State streams to the frontend over Server-Sent Events (`/events`).
- `public/` is the Mini App: canvas pixel office + Telegram WebApp SDK.
- On start, the server spawns a **Cloudflare quick tunnel** (public HTTPS URL,
  required by Telegram) and — if `BOT_TOKEN` is set — calls
  `setChatMenuButton` so your bot's menu button opens the fresh URL.

## Two shells, one renderer

| Route | What it is |
|---|---|
| `/dash` | **Desktop control room** — pixel office + live roster table + activity feed. This is the one for Chrome. |
| `/` | Telegram Mini App — phone-shaped, full-bleed canvas. |

Both load the same `app.js`, which sizes the canvas to its own CSS box rather
than the window, so the office renders identically in a grid panel and
full-screen. The dashboard's extra panels hang off `window.onRoster` instead of
opening a second SSE connection.

## It does not need Claude

Despite the name, **this server depends on Anthropic for nothing.** It reads
transcript files off disk and spawns `opencode` directly via `child_process`.
There is no Claude API call anywhere in it — the only outbound request in the
whole file is the optional Telegram menu-button wiring, which `NO_TUNNEL=1`
skips entirely.

So when Claude hits a usage limit:

- The dashboard keeps running and keeps showing the floor.
- The composer keeps dispatching work. **OpenCode bills a different provider, so
  Claude's limit is not OpenCode's limit.**
- The queue drainer keeps releasing queued jobs two at a time, every 8 seconds,
  with nobody watching.

The one thing that stops when Claude stops is *judgment* — reviewing what came
back, deciding what it means, and deciding what to do next. Everything
mechanical carries on.

**The gap to know about:** nothing starts this automatically. If the machine
reboots, or you close the window, the dashboard is down and queued work sits
still. Start it yourself with `start-hq.bat` (double-click or pin it) so it is
your process, not one borrowed from a session that might end.

## Setup

**Just want the dashboard in a browser** (no Telegram, no tunnel):

```
npm run dash     # starts the server and opens Chrome at /dash
npm run dev      # same, without opening a browser
```

**Telegram Mini App:**

1. Copy `.env.example` → `.env` and paste your bot token from @BotFather.
2. `npm start`
3. Open your bot in Telegram → tap the **🏢 Claude HQ** menu button.

The quick-tunnel URL changes on every launch, but step 3 always works because
the menu button is re-pointed automatically at startup.

### Why there's no hosted version

A published claude.ai artifact can't do this. Artifact pages run behind a strict
CSP that blocks every external host, and the only runtime capabilities available
are `downloads` and `mcp` — where `mcp` reaches claude.ai *connectors*, not your
machine. Nothing hosted off-box can read `localhost:8737` or your local
transcripts. The dashboard has to be served from the machine the agents run on.

## Notes

- Runs on the machine where Claude Code runs (it reads local transcripts) —
  this is by design; don't deploy it to a cloud host.
- **The tunnel URL is unauthenticated, and the activity feed exposes more than
  the old roster did.** It now leaks the current tool call and a 120-character
  slice of the last message — file paths, shell commands, search queries. For
  ULC work that can mean client names and tender references. Treat the URL as
  sensitive and don't share it. If you're about to work on something you
  wouldn't screenshot, run with `NO_TUNNEL=1` and use `http://localhost:8737`.
- If `~/.opencode-bridge/` doesn't exist the OpenCode scan is skipped silently —
  no contractors, no error.
