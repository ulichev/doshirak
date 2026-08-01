import { defineConfig } from 'vitest/config'
import fs from 'fs'
import path from 'path'

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify('1 января 2026'),
    'import.meta.env.VITE_SUPABASE_KEY': JSON.stringify('test-key'),
  },
  resolve: {
    alias: {
      // Сеть в тестах не нужна — подменяем клиент заглушкой
      '@supabase/supabase-js': path.resolve('./test/stubs/supabase.js'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.js'],
    restoreMocks: true,
    unstubGlobals: true,
  },
})
