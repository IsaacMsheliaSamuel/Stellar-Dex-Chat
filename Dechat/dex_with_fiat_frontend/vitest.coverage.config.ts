import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import {
  COVERAGE_REPORT_DIR,
  COVERAGE_THRESHOLDS,
  CRITICAL_SOURCE_FILES,
  CRITICAL_TEST_FILES,
} from './scripts/critical-coverage-modules.mjs';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: CRITICAL_TEST_FILES,
    exclude: ['**/node_modules/**', '**/.next/**'],
    setupFiles: [],
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: COVERAGE_REPORT_DIR,
      include: CRITICAL_SOURCE_FILES,
      exclude: ['**/*.{test,spec}.{ts,tsx}'],
      thresholds: COVERAGE_THRESHOLDS,
      cleanOnRerun: true,
    },
  },
});
