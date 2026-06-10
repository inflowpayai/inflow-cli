import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/cli.tsx'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 91,
        functions: 80,
        statements: 91,
        branches: 80,
      },
    },
  },
});
