import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Dexie needs an IndexedDB; fake-indexeddb provides an in-memory one.
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // `virtual:pwa-register` is created by vite-plugin-pwa during a build, so
      // outside one it does not resolve at all and `lib/updates.ts` cannot be
      // imported. `src/test/pwaRegister.ts` is the same shape, and is how a test
      // hands the module a service worker registration to reason about.
      'virtual:pwa-register': fileURLToPath(new URL('./src/test/pwaRegister.ts', import.meta.url)),
    },
  },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
    // Supplied by `vite.config.ts` in a real build. The value is arbitrary here;
    // what matters is that it is a build stamp the tests can differ from.
    __BUILT_AT__: JSON.stringify('2026-01-01T00:00:00.000Z'),
  },
})
