# BasenjiCode

A quiet basenji of a coding agent: it doesn't bark, and it gets things done.

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue) ![Local-first](https://img.shields.io/badge/LLM-local--first-orange) ![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

<!-- screenshot: chat + live preview pane mid-run (staged capture, added at release cut) -->

## Why BasenjiCode

BasenjiCode is a desktop app for coding with a local LLM. You chat; the model reads and edits the files in your project folder, runs shell commands, previews the result live, and verifies its own work. Open source (MIT), built on Electron.

Most coding agents assume a big cloud model. BasenjiCode is built for small local ones: the harness parses tool calls from plain text, repairs bad arguments, and stops repeated failures, so a 27B model on a single GPU can finish real tasks. The reference model is **Qwen 3.8 27B on LM Studio**. Under a plain harness it died at turn 57; under this one, the same model on the same GPU completed a 128-turn run that built a playable browser game.

Windows is the reference platform. macOS and Linux are supported and being hardened through CI.

## Install

**macOS (Apple Silicon):** download [BasenjiCode-arm64-mac.zip](https://github.com/hkristianll/basenjicode/releases/latest/download/BasenjiCode-arm64-mac.zip), unzip, and drag BasenjiCode to Applications. macOS blocks unidentified apps once on first launch — allow it under System Settings → Privacy & Security → "Open Anyway".

**Windows and Linux:** no packaged download yet — run from source (needs Node 22+):

```bash
git clone https://github.com/hkristianll/basenjicode.git
cd basenjicode
npm install
npm run dev
```

For an installable build: `npm run package:win`, `npm run package:mac`, or `npm run package:linux`.

**First run:** open Settings → Connections, add a connection (LM Studio's default is `localhost:1234`), pick a model, open a project folder, and ask for something.

## Features

### Harness for small local models

- Tool calls parsed from plain text (XML or JSON) — no native function calling needed.
- Automatic repair of mistyped tool arguments.
- Validation errors show the model the exact correct call shape.
- Circuit breakers: a model repeating the same broken call is corrected once, then stopped.
- Per-model capability profiles and thinking budgets for reasoning models.
- KV-cache-friendly prompting: byte-stable prefix for fast turns at large context on llama.cpp-based servers.
- Live "Thinking…" progress indicator while a reasoning model works.
- Crash-safe sessions: the transcript is saved after every turn.
- Context compaction that keeps project state, running dev servers, and the todo list.

### Agent capabilities

- Read, write, edit, and multi-edit files; grep/glob search; shell commands; background tasks.
- The agent can switch the chat's working folder (`set_working_folder`) — "new project, make a folder for it" re-roots the session, and the Git panel and top bar follow.
- Live in-app preview pane with screenshot feedback to the model.
- Task/todo tracking panel.
- Approval gates for risky actions; undoable edits with per-turn snapshots and rewind.
- Embedded ticket board (kanban, REST + MCP, web UI at `localhost:8930`) for planning dependency-linked work.
- Loop mode: drains the ticket board one ticket at a time, verifying each.
- Hermes orchestrator: give it a big goal; it decomposes, executes, and replans.
- Multi-model roles: planner, coder, and reviewer can be different models.

### Project playbook

Loop workers automatically see verification scripts from the project's `package.json`. To add a reusable definition
of done, create `basenjicode.playbook.json` in the project root:

```json
{
  "definitionOfDone": [
    "No new TypeScript errors",
    "Relevant tests pass",
    "User-facing behavior is documented"
  ]
}
```

The playbook is injected into every ticket seed; the ticket's own verification check remains mandatory.

## Backends

| Backend | Type | Notes |
|---|---|---|
| LM Studio | Local | Default, `localhost:1234`. Fully offline. |
| Ollama | Local | Fully offline. |
| Any OpenAI-compatible server | Local or remote | Point it at the endpoint. |
| OpenAI / Anthropic / Gemini | Cloud | Bring your own API key. |

Recommended local model: **Qwen 3.8 27B**, the reference model every harness change is benchmarked against. Any recent 27B-class instruct or thinking model runs well on a single 24 GB GPU.

## Benchmarking

`bench/` holds a task-based benchmark harness that scores agent runs on real coding tasks, using run telemetry plus a local judge model. Every harness change is validated against it.

## Safety

- Approval gates for risky actions, including shell commands.
- Edits are undoable; every turn has a snapshot you can rewind to.
- The embedded ticket board is loopback-only (`localhost:8930`).

## Optional integrations

Off by default, each needs local setup: ComfyUI image generation, and voice mode with local STT/TTS.

## Roadmap

macOS and Linux hardening — Windows is the reference platform today.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
