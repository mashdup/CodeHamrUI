import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
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
