import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["lucide-react"],
  },
  css: {
    postcss: './postcss.config.js',
  },
})