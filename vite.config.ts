import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// base './' + HashRouter keeps the app portable to any static host,
// including GitHub Pages project sites served from a sub-path.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      workbox: {
        // The OCR models (~12 MB) and ONNX Runtime WASM are fetched on first
        // receipt scan, not precached, then kept so scanning works offline.
        // ONNX Runtime's WASM is loaded from a CDN at runtime, so keep the copy
        // Vite emits into the bundle out of the precache manifest.
        globIgnores: ['**/*.wasm'],
        runtimeCaching: [
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
