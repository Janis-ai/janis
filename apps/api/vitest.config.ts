import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many suites spin up a fresh PGlite + run the full drizzle migration in
    // beforeAll — ~6s idle, past the 10s default the moment the dev machine is
    // loaded (parallel sessions, desktop churn). That's a flake class, not a
    // failure: give setup generous room so the gate only fails on real reds.
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
