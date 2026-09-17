import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The UI never talks to the API cross-origin in dev — everything goes
    // through /api, so cookies and relative URLs behave as they do in prod.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
