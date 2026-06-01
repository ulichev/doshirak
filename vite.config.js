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

export default defineConfig({
  plugins: [swVersionPlugin()],
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
