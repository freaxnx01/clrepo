import { defaultClientConditions, defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Under Vitest, Svelte 5's package `exports` map resolves to the server
    // (SSR) build unless the `browser` condition is forced, so components
    // fail to mount in jsdom with "lifecycle_function_unavailable". Everywhere
    // else Vite's own client defaults apply — spelled out rather than left as
    // `[]`, which Vite 7 reads literally as "no conditions" and which pulled
    // Svelte's SSR internals (`node:async_hooks`) into the browser bundle.
    conditions: process.env.VITEST
      ? ['browser', ...defaultClientConditions]
      : [...defaultClientConditions],
  },
  build: {
    // Output goes to internal/web/dist so go:embed picks it up.
    // Vite will NOT empty the outDir because it's outside the Vite root (web/).
    outDir: '../internal/web/dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:7777',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
