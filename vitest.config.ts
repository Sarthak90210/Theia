import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Native better-sqlite3 plus real filesystem work: forks keep each file
    // isolated and avoid worker-thread issues with the native module.
    pool: 'forks',
    testTimeout: 20_000,
  },
})
