# Screenshot harness — `shot.mjs`

Lets an agent (or you) **see** the real NordCode UI without a manual screenshot.

An Electron renderer is a Chromium page that browser-attached tools (Chrome MCP,
`preview_screenshot`) can't reach. `shot.mjs` uses Playwright's `_electron` to launch the
**actual app** — real main process, real preload/IPC, loading the built
`out/renderer/index.html` — switches between views, and writes a PNG per view that an agent can
read back.

## Usage

```bash
npm run shot                      # build, then shoot chat + raid + hermes (dark) → _shots/
npm run shot -- raid --theme light
npm run shot -- all               # chat raid hermes settings
npm run shot -- chat --skip-build # reuse existing out/ — fast iteration loop
npm run shot -- --width 1440 --height 900
```

(Or `node scripts/shot.mjs <view> …` directly.)

| Option | Meaning |
|---|---|
| views | `chat` `raid` `hermes` `settings`, or `all`. Default: `chat raid hermes` |
| `--theme` | `light` \| `dark` (default `dark`) |
| `--skip-build` | reuse existing `out/` instead of running `electron-vite build` |
| `--out <dir>` | output dir (default `_shots`) |
| `--width` / `--height` | window content size (defaults 1280×860; mins 900×540) |
| `--keep-profile` | keep the throwaway user-data dir for debugging |

Output PNGs are named `<view>-<theme>.png`. The script also prints any **renderer console
errors** it caught during the run — a free runtime smoke test.

## Notes / gotchas

- **Isolated profile.** Each run launches with a fresh `--user-data-dir` temp profile, so it
  never trips the single-instance lock against an already-open NordCode and never touches your
  real settings/sessions. Screenshots are deterministic (clean state → Welcome screen on chat).
- **Faithful, not Vite-served.** Because it launches the built `out/`, screenshots reflect what
  ships. After changing renderer source, run without `--skip-build` (or `npm run build` first)
  so the bundle is current.
- **`playwright-core`** is the only added dep — it drives the project's own Electron binary and
  downloads no browsers.
- Theme is forced via `documentElement.dataset.theme` purely for the capture; it doesn't write
  your settings.

---

# Live-attach — `launch-debug.ps1` + `peek.mjs`

`shot.mjs` launches a clean throwaway app. **Live-attach** is the opposite: it screenshots the app
**you're already running** — your real session, model, working folder, and the exact state you're
staring at when a bug shows up.

```bash
# 1. Start NordCode with the DevTools port open (once per testing session):
pwsh ./scripts/launch-debug.ps1          # installed build
pwsh ./scripts/launch-debug.ps1 -Dev     # electron-vite dev build
pwsh ./scripts/launch-debug.ps1 -Port 9333

# 2. Any time you hit a visual issue, capture what's on screen:
npm run peek                 # → _shots/peek.png
npm run peek -- --out bug.png
npm run peek -- --wait 1500  # listen longer for console errors before capturing
```

How it works: the launcher opens NordCode with `--remote-debugging-port` (Chromium binds it to
127.0.0.1 only); `peek.mjs` connects over CDP with `chromium.connectOverCDP`, finds the renderer
page (skipping DevTools targets and the Preview `<webview>`), screenshots it, and **disconnects
without closing or steering the app**. It also reports any renderer console errors in the sample
window.

Gotchas:
- **Installed build needs no rebuild** — Electron honours `--remote-debugging-port` off the command
  line, so this works with whatever build is installed today. The `-Dev` path instead relies on the
  `NORDCODE_REMOTE_DEBUG` env gate in `src/main/index.ts`.
- The launcher **closes any running NordCode first** — a 2nd instance would just hit the
  single-instance lock and exit without binding the port. Sessions persist to disk, so this is safe.
- Opening a debug port is opt-in and loopback-only, but it does let any local process attach to the
  renderer. Use it during testing, not as a permanent launch mode.
