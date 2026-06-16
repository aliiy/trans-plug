/**
 * Vite config reference — the actual build uses build.mjs (programmatic API)
 * to produce three separate bundles (content IIFE, background IIFE, popup HTML).
 * This file exists for IDE TypeScript support only.
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
