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

// Локальная разработка (npm run dev / preview) в прод НЕ ходит: там только реальные
// данные пользователей, а тестовые аккаунты и демо туда уже утекали. Прокси /sb
// включается лишь осознанно: DOSHIK_DEV_PROD=1 npm run dev
const ALLOW_PROD = process.env.DOSHIK_DEV_PROD === '1';
function blockProdPlugin() {
  // Ничего не возвращаем: функция из configureServer считалась бы post-хуком
  const block = (server) => { server.middlewares.use((req, res, next) => {
    if (!/^\/(sb|api)(\/|$)/.test(req.url || '')) return next();
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 'DEV_NO_PROD', message: 'Прод отключён в локальной разработке (DOSHIK_DEV_PROD=1 — включить)' }));
  }); };
  return { name: 'block-prod', configureServer: block, configurePreviewServer: block };
}
const devProxy = ALLOW_PROD ? {
  '/sb': {
    target: SUPABASE_URL,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/sb/, '')
  }
} : {};
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export default defineConfig({
  plugins: [swVersionPlugin(), ...(ALLOW_PROD ? [] : [blockProdPlugin()])],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_DEV_PROD': JSON.stringify(ALLOW_PROD ? '1' : ''),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(
      new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    ),
  },
  server: { proxy: devProxy },
  preview: { proxy: devProxy }
})
