import { defineConfig } from 'vitest/config';

// Database hooks (creating seeded test schemas, deleting a full 60-day simulation run between tests) take about 1 s
// locally but can exceed vitest's default 10 s hook limit on a busy shared CI runner. Allow 60 s, the same limit the
// multi-day simulation tests use per test. No test logic depends on this value.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
