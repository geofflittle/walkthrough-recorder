import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // node, not jsdom: only the two page-script suites need a DOM, and they ask
    // for one with an @vitest-environment comment of their own.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
