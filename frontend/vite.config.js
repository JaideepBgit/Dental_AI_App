import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Proxy /api to the backend so the browser sees one origin. Session cookies
  // then work without CORS credential rules, and dev behaves the same as the
  // container build where FastAPI serves this bundle itself.
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8000',
        changeOrigin: true,
        // Cookies are set for localhost by the backend; no rewrite needed since
        // the backend already namespaces everything under /api.
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    // node_modules is huge here; without this Vitest walks it looking for specs.
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
})
