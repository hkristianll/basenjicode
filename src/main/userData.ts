import path from 'node:path'

/**
 * The app was renamed NordCode → BasenjiCode. Electron derives userData from the product name, so
 * the rename alone would point at a fresh, empty %APPDATA%\basenjicode and boot amnesiac —
 * sessions, settings, snapshots, board.db, and modelProfiles.json all live in the original
 * directory. Rule: keep using the legacy dir when it exists and the new default has not been
 * adopted. No copying — zero data-loss risk. Pure so the decision is unit-testable.
 *
 * @returns the legacy dir to pin via app.setPath('userData', …), or null to keep the default.
 */
export function resolveUserDataDir(defaultDir: string, exists: (p: string) => boolean): string | null {
  const legacy = path.join(path.dirname(defaultDir), 'nordcode')
  if (path.resolve(legacy) === path.resolve(defaultDir)) return null
  // Adoption = a real settings.json in the new dir — NOT mere directory existence: Chromium
  // (crashpad/GPU caches) creates the default userData dir before any app code runs, so an
  // exists() check on the dir itself is already true on the very first renamed launch.
  const adopted = exists(path.join(defaultDir, 'settings.json'))
  if (exists(path.join(legacy, 'settings.json')) && !adopted) return legacy
  return null
}
