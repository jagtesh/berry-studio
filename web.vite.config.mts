import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer/windows/web'),
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@cherrystudio/ui': resolve('packages/ui/src')
    }
  }
})
