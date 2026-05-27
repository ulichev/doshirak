import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/sb': {
        target: 'https://stfdtkorhvdmsrhelide.supabase.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sb/, '')
      }
    }
  }
})
