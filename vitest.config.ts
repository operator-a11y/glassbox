import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'examples/**/*.test.ts'],
    environment: 'node',
    // The whole point of Phase 0 is determinism; flaky tests would defeat it.
    // Tests never touch the network and run against the deterministic stub model.
    testTimeout: 20_000,
  },
});
