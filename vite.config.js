import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

// Плагин: заменяет __BUILD_TIME__ в dist/sw.js на timestamp сборки.
// Браузер видит изменённый файл и запускает updatefound → тост «Доступно обновление».
function swVersionPlugin() {
  return {
    name: 'sw-version',
    closeBundle() {
      const swPath = path.resolve('dist/sw.js')
      if (!fs.existsSync(swPath)) return
      const ts = Date.now().toString()
      const content = fs.readFileSync(swPath, 'utf8').replace('__BUILD_TIME__', ts)
      fs.writeFileSync(swPath, content)
    }
  }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://stfdtkorhvdmsrhelide.supabase.co';

export default defineConfig({
  plugins: [swVersionPlugin()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.npm_package_version || '1.0.0'),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(
      new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    ),
  },
  server: {
    proxy: {
      '/sb': {
        target: SUPABASE_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sb/, '')
      }
    }
  }
})
