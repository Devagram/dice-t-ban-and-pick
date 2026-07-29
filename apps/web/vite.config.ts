import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Built into `apps/worker/public`, so the Worker serves it.
 *
 * §11 says "serve the client from Cloudflare Pages on the same account". Workers static assets
 * do the same job and one thing better: **same origin**. The Worker mints the resume link and
 * the WebSocket URL from the request origin (D17/D20), so a split origin would mean CORS on
 * every lobby call and a cross-origin WebSocket — complexity bought for nothing, since both
 * halves deploy to the same account either way. One `wrangler deploy` ships both.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../worker/public',
    emptyOutDir: true,
  },
  server: {
    // `wrangler dev` on 8787; the dev server proxies the API and the socket to it so local
    // development hits the real Durable Object rather than a mock.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
