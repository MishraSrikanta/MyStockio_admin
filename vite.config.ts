import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  /* Relative asset paths, so the built folder works from a domain root, a subdirectory or a CDN
     path without rebuilding. */
  base: './',
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: {
    /*
     * A port of its own, so this can run at the same time as MyStockio (5173) and MyCodeScan
     * (5175) without either having to be stopped.
     */
    port: 5177,
    host: true,
  },
})
