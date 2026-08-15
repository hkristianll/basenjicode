# BasenjiCode bench task suite

This directory defines the fixed task inputs for the local-agent benchmark. Task definitions and fixtures
are data only; the runner copies a fixture into a fresh workspace before every run.

## Task schema

Every `tasks/*.json` file contains:

- `id`: unique, stable task id.
- `title`: human-readable task name.
- `prompt`: exact user prompt. Board tasks use `null` because their work comes from `miniTickets`.
- `fixture`: repository-relative path to a template directory. `bench/fixtures/empty` contains only a
  `.gitkeep`, which the runner may ignore when copying.
- `completionChecks`: ordered checks, each `{ "type": ..., "arg": ... }`.
  - `fileExists`: `arg` is a path relative to the fresh run workspace.
  - `shellExitZero`: `arg` is a command run with the fresh workspace as its current directory.
  - `httpOk`: `arg` is a path requested from the HTTP server started by the runner; an absolute HTTP URL
    is also allowed.
- `maxTurns`: positive integer tool-round limit.
- `notes`: evaluator-facing intent and any seeded-fixture details.

The board-only T4 definition additionally sets `type: "board"` and supplies exactly three
`miniTickets`, each with `title`, `body`, and `check`. Its fixture is documentation only; the runner creates
the mini tickets on the local board instead of prompting an ordinary chat session.

## Validation

Run the complete suite validator from the repository root:

```sh
node bench/validate.mjs
```

`validateTask` is exported as a pure function for unit tests. The CLI also accepts explicit JSON paths and
returns nonzero for malformed input:

```sh
node bench/validate.mjs bench/malformed-task.sample.json
```

The task runner and scoring/judging logic intentionally live in later Phase 0 tickets.
