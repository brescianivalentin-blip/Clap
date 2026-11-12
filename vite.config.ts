import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE is set by the deployment workflow (e.g. "/clap/" on GitHub Pages).
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Clap — Montage vidéo',
        short_name: 'Clap',
        description: 'Montage vidéo simple et professionnel pour TikTok, Instagram et YouTube.',
        lang: 'fr',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b0b0f',
        theme_color: '#0b0b0f',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,json}'],
        globIgnores: ['music/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/music/'),
            handler: 'CacheFirst',
            options: { cacheName: 'music', expiration: { maxEntries: 80 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
