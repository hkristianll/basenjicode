// Single-flight slot for Hermes runs (O4): only ONE orchestration runs at a time. A second start is refused
// (the caller surfaces a "team already running for X" message) rather than silently aborting the first — true
// per-project concurrency would just thrash the single local GPU's model-swap. Pure (no electron), so it
// unit-tests headless; ipc.ts owns the one live instance.
//
// The TOKEN is the subtlety: a run clears the slot when it finishes, but a stop→start swap may already have
// replaced it with a newer run. `finish(token)` clears ONLY if the slot still belongs to that token, so a
// finishing old run can't wipe the new run's slot.

export interface SingleFlight {
  /** Claim the slot. On success returns a token to pass back to finish(); on failure names the busy project. */
  tryStart(project: string): { ok: true; token: object } | { ok: false; busyProject: string }
  /** Release the slot IFF `token` still owns it (no-op if a newer run has taken it). */
  finish(token: object): void
  /** Force-release the slot (an explicit Stop) so a new run can start immediately. */
  clear(): void
  /** The active run's project, or null when idle. */
  activeProject(): string | null
}

export function createSingleFlight(): SingleFlight {
  let slot: { project: string; token: object } | null = null
  return {
    tryStart(project) {
      if (slot) return { ok: false, busyProject: slot.project }
      const token = {}
      slot = { project, token }
      return { ok: true, token }
    },
    finish(token) {
      if (slot?.token === token) slot = null
    },
    clear() {
      slot = null
    },
    activeProject() {
      return slot?.project ?? null
    }
  }
}
