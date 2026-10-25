// Windows 应用图标：和 mac、安卓同一张像素图（画法见 scripts/macos/icon.mjs），按 Windows 的习惯底板
// 几乎铺满、不带投影。各尺寸都存成 PNG 放进 .ico，Windows 10 都认。
import fs from 'node:fs'
import { draw, png, readArt } from '../macos/icon.mjs'

const PLATE = { side: 960, radius: 190, shadow: false }
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256]

/** 生成 out（.ico），返回启动页上用的 192 见方 PNG */
export function makeIcon(root, out) {
  const art = readArt(root)
  const images = SIZES.map((size) => png(size, draw(size, art, PLATE)))
  const header = Buffer.alloc(6 + 16 * SIZES.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(SIZES.length, 4)
  let offset = header.length
  SIZES.forEach((size, i) => {
    const at = 6 + 16 * i
    // 宽高各一个字节，256 记作 0
    header.writeUInt8(size % 256, at)
    header.writeUInt8(size % 256, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[i].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += images[i].length
  })
  fs.writeFileSync(out, Buffer.concat([header, ...images]))
  return png(192, draw(192, art, PLATE))
}
