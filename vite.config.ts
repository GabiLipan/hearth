import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// base './' + HashRouter keeps the app portable to any static host,
// including GitHub Pages project sites served from a sub-path.
export default defineConfig({
  base: './',
  define: {
    /**
     * When this build was made.
     *
     * The package version says nothing useful — it has been 1.0.0 all along —
     * and what somebody actually wants to know is whether the app in their
     * hand is the one that was deployed. A timestamp answers that, and it is
     * the only thing Settings can honestly show about "which version is this".
     */
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      /**
       * A new version waits to be asked for, rather than taking over.
       *
       * `autoUpdate` reloads the page the moment a new service worker
       * activates, which is fine on a desktop tab and wrong in an installed
       * app: the reload can land in the middle of typing a transaction. It was
       * also not delivering — an installed PWA on iOS is usually RESTORED
       * rather than launched, so the page never loads, nothing ever checks, and
       * the only way to get a new version was to kill the app repeatedly.
       *
       * So the app checks on its own terms (see `lib/updates.ts`) and says so.
       */
      registerType: 'prompt',
      // Registered from `lib/updates.ts` instead, which is what lets the app
      // check on demand and report what it found. Left on 'auto' the plugin
      // would inject a second registration into index.html.
      injectRegister: null,
      includeAssets: ['icons/apple-touch-icon.png'],
      workbox: {
        // The OCR models (~12 MB) and ONNX Runtime WASM are fetched on first
        // receipt scan, not precached, then kept so scanning works offline.
        // ONNX Runtime's WASM is loaded from a CDN at runtime, so keep the copy
        // Vite emits into the bundle out of the precache manifest.
        globIgnores: ['**/*.wasm'],
        // Never let the service worker touch Supabase. A cached PostgREST
        // response replayed to the pull loop would write stale rows into the
        // cache with nothing to reveal they were stale — and the cache would
        // then look authoritative. All API traffic must reach the network or
        // fail honestly so the outbox can retry.
        navigateFallbackDenylist: [/^https:\/\/[a-z0-9-]+\.supabase\.co\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\/models\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-models',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'onnxruntime-wasm',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Hearth — Family Finance',
        short_name: 'Hearth',
        description: 'Budgeting, bills and spending for the two of us',
        theme_color: '#1a1a19',
        background_color: '#f9f9f7',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
