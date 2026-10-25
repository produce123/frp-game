// 外壳模板以文本导入，构建时由 Vite 的 ?raw 处理
declare module '*.html?raw' {
  const html: string
  export default html
}
// 图片以地址导入，构建时由 Vite 处理
declare module '*.svg' {
  const url: string
  export default url
}
