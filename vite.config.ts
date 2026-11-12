import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The build inlines all JavaScript and CSS into dist/index.html, so the result
// is one self-contained file that works when opened straight from disk.
export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // main.ts only wires the page together; it is not unit-tested.
      exclude: ['src/main.ts'],
    },
  },
});
