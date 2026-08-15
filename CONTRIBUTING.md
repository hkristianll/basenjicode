# Contributing to BasenjiCode

Thanks for helping make small local models better coding agents.

## Dev setup

- Node 22+, npm.
- `npm install`, then `npm run dev` (electron-vite dev build with hot reload).
- A local model server (LM Studio at `localhost:1234` or Ollama) makes the agent usable;
  the reference model is **Qwen 3.8 27B**.

## Before you open a PR

- `npm run typecheck` and `npm test` must be green (CI runs both on Windows, macOS, and Linux).
- One concern per PR. Small and reviewable beats big and clever.
- New behavior needs a test next to the code it changes (`*.test.ts`, vitest).
- Windows behavior is the reference: platform work must leave existing Windows verdicts
  byte-identical unless the PR is explicitly about changing them.

## Harness changes

Anything touching the agent loop, tool-call recovery, prompts, or context management is a
HARNESS change — validate it with the benchmark in `bench/` (see `bench/README.md`) rather than
by vibes. State the before/after numbers in the PR.

## Conduct

Be kind, be concrete, assume good intent.
