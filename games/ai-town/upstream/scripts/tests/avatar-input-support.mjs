import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../frontend/town-2d/package.json', import.meta.url))
const ts = require('typescript')

// 使用实际输入模块，替换浏览器的事件目标和定时器；不复制输入逻辑。
export function walkingHarness(emit, enabled = () => true, navigationDeps) {
  const window = new EventTarget(),
    document = new EventTarget()
  document.querySelector = () => null
  let frame,
    doors = 0
  window.setInterval = (fn) => {
    frame = fn
    return 1
  }
  class Element {
    tagName = 'INPUT'
    isContentEditable = false
  }
  const modules = new Map()
  const load = (name) => {
    if (modules.has(name)) return modules.get(name)
    const scope = {
      exports: {},
      window,
      document,
      HTMLElement: Element,
      performance,
      clearInterval() {},
      require: (name) => load(name.replace('./', '')),
    }
    const source = fs.readFileSync(
      new URL(`../../frontend/town-shared/src/avatar/${name}.ts`, import.meta.url),
      'utf8'
    )
    vm.runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      scope
    )
    modules.set(name, scope.exports)
    return scope.exports
  }
  const abort = new AbortController()
  const navigation =
    navigationDeps &&
    load('navigation').createAvatarNavigation({
      ...navigationDeps,
      signal: abort.signal,
    })
  const input = navigation
    ? { stop: () => navigation.stopMoving() }
    : load('input').createWalkingInput(
        enabled,
        (d) => emit(Array.from(d)),
        () => doors++,
        abort.signal
      )
  const event = (target, type, props = {}) =>
    target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props))
  return {
    window,
    document,
    Element,
    event,
    input,
    navigation,
    abort,
    frame: () => frame(),
    doors: () => doors,
  }
}
