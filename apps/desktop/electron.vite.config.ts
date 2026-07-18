import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        // Two preload entries: the host renderer's API (index) and the
        // webview guest's dialog bridge (webview). Both compile to
        // out/preload/*.js.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          webview: resolve(__dirname, 'src/preload/webview.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: {
      // Dev-only: uncommon pinned port so we never collide with other local
      // backends. Production loads static files — no server, no port.
      port: 24888,
      strictPort: false,
    },
  },
})
