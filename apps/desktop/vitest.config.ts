import type { TestProjectConfiguration } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const reactUi: TestProjectConfiguration = {
  extends: './vite.config.ts',
  test: {
    name: 'ui',
    environment: 'jsdom',
    // Keep padding regressions observable instead of mocking the stylesheet away.
    css: { include: [/status-stack\.css$/] },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    // The first test in each file pays jsdom env init + full module transform,
    // which can exceed vitest's 5000ms default under CI/load. 15s gives the
    // cold start headroom without masking genuinely hung tests. Hooks pay the
    // same cold cost when a beforeEach does `vi.resetModules()` + `await
    // import(...)` (65 files); one timed out at 10s on CI (#120318).
    testTimeout: 15_000,
    hookTimeout: 30_000
  }
}

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    // `e2e/**/*.unit.test.ts` is the e2e HELPERS, not the specs: plain node
    // modules that should be provable without booting Electron. Playwright
    // ignores the same pattern so they run in exactly one runner.
<<<<<<< HEAD
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}', 'e2e/**/*.unit.test.ts'],
    // These are node:test suites, retained by the explicit Node runner in
    // test:managed (or their named repro command), not Vitest suites.
    exclude: [
      'scripts/run-short-session-hang-repro.test.mjs',
      'scripts/tasks-scroll.test.mjs',
      'scripts/notarize.test.mjs',
      'scripts/sign-mac.test.mjs',
      'scripts/verify-managed-update-release.test.mjs'
    ]
||||||| 939e45c91d
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}', 'e2e/**/*.unit.test.ts'],
    // These use node:test and have dedicated npm scripts, not Vitest suites.
    exclude: ['scripts/run-short-session-hang-repro.test.mjs', 'scripts/tasks-scroll.test.mjs']
=======
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}', 'e2e/**/*.unit.test.ts']
>>>>>>> f97608f178
  }
}

export default defineConfig({
  test: {
    projects: [reactUi, electronNative]
  }
})
