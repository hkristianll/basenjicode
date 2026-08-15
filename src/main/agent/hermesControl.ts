// The seam between Brooke's control tools and the live Hermes runtime (boardRunner + runHermes + loopBoard).
// ipc.ts implements + installs the controller (it owns settings, the project, and the orchestrator); the
// control tools in tools/hermesTools.ts call it. Keeping this an interface means the tools stay thin and the
// orchestration wiring lives in one place. A single Hermes context is active at a time (one drain), so one
// installed controller is enough.

export interface HermesController {
  /** Launch the team on a goal: decompose → drain → replan/critic for the active project. Returns a status line. */
  startGoal(goal: string): Promise<string>
  /** File a new ticket into a department (role) on the active project. `deps` are ids of existing tickets it must
   *  wait for, so runtime-added work that builds on/tests existing tickets runs in order (not immediately). */
  addWork(input: { title: string; body?: string; role?: string; check?: string; deps?: number[] }): Promise<string>
  /** Re-engage a review/parked ticket (→ todo) so the team picks it up again. */
  reopen(id: number): Promise<string>
  /** Cancel a stale/obsolete ticket (→ cancelled), removing it from the team's active work. Reversible via reopen. */
  cancel(id: number, reason?: string): Promise<string>
  /** Edit a ticket IN PLACE (body / check / priority) — fix a broken check or refine scope without re-filing a
   *  duplicate. The board PATCH endpoint backs this; reopen the ticket afterwards if it had parked. */
  editTicket(id: number, fields: { body?: string; check?: string; priority?: number }): Promise<string>
  /** Find duplicate tickets (same work re-filed) and cancel all but the most-advanced copy of each. Reversible.
   *  Lets the group manager clean up the re-file churn she otherwise can't see ticket-by-ticket. */
  dedupeBoard(): Promise<string>
  /** Run one improvement pass now: the critic reviews the project and files follow-up tickets. */
  requestImprove(): Promise<string>
  pause(): Promise<string>
  resume(): Promise<string>
  stop(): Promise<string>
  /** A department-by-department status snapshot of the active project's board. */
  teamStatus(): Promise<string>
  /** Toggle "keep working until stopped" mode: when on, the run never self-terminates — it convenes a manager
   *  meeting for more improvements and idles on-call; only stop() ends it. */
  keepWorking(on: boolean): Promise<string>
}

// One controller PER PROJECT — each project's Brooke is independently instanced, so "start" / "status" always
// act on HER project, never on whichever was opened last.
const controllers = new Map<string, HermesController>()

/** Install (or replace) a project's controller. Called by ipc.ts when a project's Brooke is set up. */
export function setHermesController(project: string, c: HermesController): void {
  controllers.set(project, c)
}

/** A project's controller, or a thrown error Brooke surfaces to the user if it isn't wired yet. */
export function hermesController(project: string | undefined): HermesController {
  const c = project ? controllers.get(project) : undefined
  if (!c) throw new Error('This project is not wired up yet — reopen its Hermes view.')
  return c
}
