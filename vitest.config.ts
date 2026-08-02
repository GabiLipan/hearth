import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Dexie needs an IndexedDB; fake-indexeddb provides an in-memory one.
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
  },
})
