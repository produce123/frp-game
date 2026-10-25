// 建镇的诊断输出。设置环境变量 MAPGEN_DEBUG=<文件路径> 后，各环节的失败原因逐行异步追加
// 到这个文件；不设置时 debug 是 null，调用处写 debug?.(…)，诊断内容不会被计算。
// 网页里（手机应用建镇）没有 process 和文件系统，这时 debug 一律是 null。
const file = globalThis.process?.env?.MAPGEN_DEBUG
let written = Promise.resolve()
/** 写文件的模块只在 Node 里、真的要写诊断时才加载；名字放在变量里，网页打包时不去解析它 */
const FS_MODULE = 'node:fs/promises'

export const debug = file
  ? (line) => {
      written = written
        .then(async () => {
          const { appendFile } = await import(/* @vite-ignore */ FS_MODULE)
          await appendFile(file, line + '\n')
        })
        .catch(() => {})
    }
  : null

/** 等排队的诊断行写完。生成在工作线程里跑，交回结果前调用，线程被结束时不丢行。 */
export const flushDebug = () => written
