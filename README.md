

# BasenjiCode

A quiet basenji of a coding agent: it doesn't bark, and it gets things done.

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue) ![Local-first](https://img.shields.io/badge/LLM-local--first-orange) ![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

<!-- screenshot: chat + live preview pane mid-run (staged capture, added at release cut) -->

## Why BasenjiCode

BasenjiCode is a local-first, open-source (MIT) Electron desktop app that lets you chat with a model while it reads, writes, and edits code in a project folder, runs shell commands and background dev servers, previews the result live, and verifies its own work. It is built specifically to make small local models reliable coding agents. Windows is the reference platform; macOS/Linux support is built in and being hardened through CI.

Developed and battle-tested against **Qwen 3.8 27B on LM Studio**: the harness took the same model from a circuit-breaker death at turn 57 to a clean self-verified 128-turn run building a playable browser game — same GPU, same prompt, better harness. Every harness change is validated on real coding tasks with Qwen 3.8 27B as the reference model; Qwen 3.6, Qwen coder variants, and any other LM Studio / Ollama / OpenAI-compatible model work the same way.

## Features

### Harness for small local models

- Text-format tool-call recovery: XML/JSON forms are parsed from plain output, with no reliance on native function calling.
- Automatic repair of mistyped tool arguments.
- Validation errors that show the model the exact correct call shape.
- Deterministic-failure circuit breakers: a model repeating the same broken call gets corrected once, then stopped.
- KV-cache-friendly prompting: byte-stable prefix for fast turns at large context on llama.cpp-based servers.
- Live “Thinking…” progress indicator for reasoning models.
- Per-turn transcript persistence for crash-safe sessions.
- Compaction that preserves project state, live dev-server handles, and the todo list.

### Agent capabilities

- Chat mode with tool use: read/write/edit/multi-edit files, grep/glob, shell, background tasks.
- Live in-app preview pane with screenshot feedback to the model.
- Task/todo tracking panel.
- Approval gates for risky actions with undoable edits and per-turn snapshots + rewind.
- Embedded ticket board: kanban with REST + MCP faces, web UI at `localhost:8930`, for planning dependency-linked work.
- Loop mode: autonomously drains the ticket board one ticket at a time with per-ticket verification.
- Hermes orchestrator: give it a big goal; it decomposes, executes, and replans.
- Multi-model role assignment: planner/coder/reviewer can be different models.

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

## Benchmarking

BasenjiCode ships with a task-based benchmark harness (`bench/`) that scores agent runs on real coding tasks from telemetry + a local judge model. It is used to validate every harness change.

## Backends

| Backend | Category | Notes |
|---|---:|---|
| LM Studio | Local, primary | `localhost:1234`; fully offline operation with a local backend |
| Ollama | Local | Fully offline operation with a local backend |
| Any OpenAI-compatible endpoint | Compatible | Use an existing OpenAI-compatible server or endpoint |
| OpenAI | Cloud | Bring your own API key |
| Anthropic | Cloud | Bring your own API key |
| Gemini | Cloud | Bring your own API key |

## Requirements

- Windows 10/11, macOS, or Linux
- Node 22+ and npm
- A local model server (LM Studio or Ollama) OR a cloud API key
- Recommended local model: **Qwen 3.8 27B** (the reference model the harness is benchmarked against); any recent 27B-class instruct/thinking model runs well on a single 24 GB GPU

## Quickstart

```bash
git clone <repo-url>
npm install
npm run dev
```

For an installable build:

```bash
npm run build
# then use electron-builder
```

In Settings, add a connection (LM Studio default `localhost:1234`), pick a model, open a project folder, and ask for something.

## Safety

- Approval gates for risky actions, including shell command use.
- Edits are undoable; each turn has a snapshot you can rewind to.
- The embedded ticket board is loopback-only at `localhost:8930`.

## Optional integrations

Optional integrations are off by default and need local setup:

- ComfyUI image generation
- Voice mode with local STT/TTS

## Roadmap

Cross-platform support, thinking budgets, and model capability profiles. macOS/Linux support is in active development.

## Contributing

PRs welcome.

## License

MIT
