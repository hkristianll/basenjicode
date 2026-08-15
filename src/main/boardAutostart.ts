// Bring up the ticket board on launch. The board (REST + MCP + SSE + web UI) powers the Hermes / Raid /
// board views. NordCode now hosts it IN-PROCESS (src/main/board/server.ts) instead of depending on a
// separate app in another folder — so a fresh install is self-contained: data lives in userData/board.db
// and the service starts itself. If something is ALREADY answering on :8930 (e.g. the user runs the old
// standalone board, or a previous launch's instance), we defer to it and don't start a second one.
// Decision logic is pure (effects injected) so it unit-tests headless; the live start is a dynamic import
// so tests never load the sqlite/MCP server. Best-effort throughout: a start failure logs, never throws.

const BOARD_URL = (process.env.TICKET_BOARD_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '')

/** True when the board answers an HTTP request within the timeout — used to skip starting a second instance. */
export async function boardReachable(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${BOARD_URL}/api/projects`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** Poll until the board answers — after a start it needs a moment to bind the port, and the first decompose
 *  write must not race a not-yet-listening server. `reachable` + `sleep` are injectable for headless tests. */
export async function waitForBoardReady(opts: { reachable?: () => Promise<boolean>; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const reachable = opts.reachable ?? boardReachable
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = opts.timeoutMs ?? 8000
  const intervalMs = opts.intervalMs ?? 250
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    if (await reachable()) return true
    await sleep(intervalMs)
  }
  return false
}

export interface BoardAutostartDeps {
  reachable: () => Promise<boolean>
  /** Start the in-process board listening on :8930. Injected in tests; the live default dynamic-imports the server. */
  start: (dbPath: string, publicDir: string, log?: (msg: string) => void) => Promise<void>
}

export type BoardAutostartResult = 'already-up' | 'started' | 'error'

// Process-wide guard: only ever start one in-process board, even if several call sites race ensureBoardRunning.
let startedInProcess = false

/**
 * Ensure the ticket board is running. If it's already reachable (our own from a prior call, or an external
 * standalone instance), do nothing. Otherwise start the in-process board with its DB at `dbPath` and the web
 * UI served from `publicDir`. Returns what it did so callers/tests can assert.
 */
/**
 * App-launch sequencing for the board + its MCP connection: bring the board up, wait for it to answer
 * (only a fresh start needs the poll), then re-run the MCP sync so the built-in 'board' server — whose
 * first connect attempt raced the port bind and lost on a cold launch — leaves its error state and its
 * tools register. Best-effort like everything board-side: the resync runs even after a failed start, so
 * the retry (and its clear error) is never skipped. Deps injected for headless tests.
 */
export async function ensureBoardThenResyncMcp(opts: {
  ensure: () => Promise<BoardAutostartResult>
  waitReady: () => Promise<boolean>
  resync: () => void
}): Promise<void> {
  const r = await opts.ensure()
  if (r === 'started') await opts.waitReady()
  opts.resync()
}

export async function ensureBoardRunning(
  paths: { dbPath: string; publicDir: string },
  log?: (msg: string) => void,
  deps: Partial<BoardAutostartDeps> = {}
): Promise<BoardAutostartResult> {
  const reachable = deps.reachable ?? boardReachable
  const start =
    deps.start ??
    (async (dbPath: string, publicDir: string, l?: (msg: string) => void) => {
      const { startBoardServer } = await import('./board/server.js')
      await startBoardServer({ dbPath, publicDir, log: l })
    })
  if (startedInProcess) return 'already-up'
  if (await reachable()) return 'already-up'
  try {
    await start(paths.dbPath, paths.publicDir, log)
    startedInProcess = true
    log?.('Started the in-process ticket board.')
    return 'started'
  } catch (e) {
    log?.(`Could not start the ticket board: ${e instanceof Error ? e.message : String(e)}`)
    return 'error'
  }
}
