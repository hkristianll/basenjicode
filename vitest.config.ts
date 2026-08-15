import { defineConfig, configDefaults } from 'vitest/config'

// Vitest's own config. Without it, vitest falls back to the default include (`**/*.test.ts` from the repo
// root) and picks up `tmp/nordcode-rollback/` — a gitignored backup copy of the source tree — inflating the
// suite with ~24 stale, duplicate test files that run against a divergent snapshot (false red/green risk) and
// are absent in a clean checkout. Pin the suite to the real source tree plus the dependency-free bench tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'bench/**/*.test.mjs'],
    exclude: [...configDefaults.exclude, 'tmp/**']
  }
})
