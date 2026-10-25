import { compressedAssetsPlugin } from '../../scripts/performance/compressed-assets-plugin.mjs'
import { defineConfig } from 'vite'
import { writeClientBuildState } from '../../scripts/client-build-state.mjs'
import { fileURLToPath } from 'node:url'
const proxy = {
  '/data/props': { target: `http://127.0.0.1:${process.env.TOWN_MANAGER_PORT ?? 8788}` },
  '/api/towns': { target: `http://127.0.0.1:${process.env.TOWN_MANAGER_PORT ?? 8788}` },
}
export default defineConfig({
  // 平台把它挂在 /ai-town/ 下（不是站点根）。改这里以后，
  // 静态资源、动态 import、index/game 两个入口都会自动带前缀。
  base: '/ai-town/',
  publicDir: false,
  plugins: [
    compressedAssetsPlugin(),
    {
      name: 'formal-client-build-state',
      apply: 'build',
      async closeBundle() {
        await writeClientBuildState(
          fileURLToPath(new URL('../../', import.meta.url)),
          fileURLToPath(new URL('./dist', import.meta.url))
        )
      },
    },
  ],
  server: { port: 5174, host: '127.0.0.1', strictPort: true, proxy },
  preview: { port: 5174, host: '127.0.0.1', strictPort: true, proxy },
  build: {
    rollupOptions: {
      input: { index: 'index.html', game: 'game.html' },
    },
  },
})
