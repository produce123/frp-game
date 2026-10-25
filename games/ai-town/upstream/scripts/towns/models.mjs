// 首页「设定」的模型服务：读、存、连通测试。逻辑在 host::models，经 town-map 子进程调用；
// 手机上的管理服务直接调同一份（crates/manager/src/routes.rs），两边路径和回答一样。
import { worker } from './workers.mjs'

export function createModelRoutes({ source, config, serial }) {
  const run = (mode, input, options) => worker(source, config, mode, input, options)
  return [
    ['GET', /^\/api\/towns\/models$/, () => run('models', {}, { timeout: 10000 })],
    // 两次保存同时读改写密钥文件会丢掉一个，排队执行
    [
      'POST',
      /^\/api\/towns\/models$/,
      ({ body }) => serial('models', () => run('save-models', body, { timeout: 10000 })),
    ],
    [
      'POST',
      /^\/api\/towns\/models\/test$/,
      ({ body, signal }) => run('test-model', body, { signal, timeout: 60000 }),
    ],
  ]
}
