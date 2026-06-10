import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: process.env.COVERAGE_DIR ?? 'coverage',
      thresholds: {
        statements: 91,
        branches: 85,
        functions: 91,
        lines: 91,
      },
    },
  },
});
