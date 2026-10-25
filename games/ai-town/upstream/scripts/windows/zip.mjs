// 打 zip。文件名按 UTF-8 存，并打上 UTF-8 标记（通用标志第 11 位）：不打的话 Windows 资源管理器按本地
// 代码页解压，「AI小镇」会变成乱码。macOS 自带的 zip 不打这个标记，所以自己写。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const UTF8 = 0x0800

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** 把 dir 连同它这一层文件夹压进 out；返回文件数 */
export function zipFolder(dir, out) {
  const files = []
  const walk = (from) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const full = path.join(from, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
      else throw Error(`zip 里不放链接和特殊文件：${full}`)
    }
  }
  walk(dir)
  files.sort()
  if (files.length >= 0xffff) throw Error('文件太多，要用 zip64')
  const stamp = dosTime(new Date())
  const fd = fs.openSync(out, 'w')
  const central = []
  let offset = 0
  const write = (buffer) => {
    fs.writeSync(fd, buffer)
    offset += buffer.length
  }
  try {
    for (const file of files) {
      const name = Buffer.from(
        path.relative(path.dirname(dir), file).split(path.sep).join('/'),
        'utf8'
      )
      const data = fs.readFileSync(file)
      const deflated = zlib.deflateRawSync(data, { level: 9 })
      // 图片、音频这类已经压过的，再压反而变大，原样存
      const stored = deflated.length >= data.length
      const body = stored ? data : deflated
      const crc = zlib.crc32(data)
      if (offset + body.length > 0xffffffff) throw Error('压缩包超过 4 GB，要用 zip64')
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(UTF8, 6)
      local.writeUInt16LE(stored ? 0 : 8, 8)
      local.writeUInt16LE(stamp.time, 10)
      local.writeUInt16LE(stamp.date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(body.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      const entry = Buffer.alloc(46)
      entry.writeUInt32LE(0x02014b50, 0)
      // 生成方记作 FAT（高字节 0），属性字段按 Windows 的理解
      entry.writeUInt16LE(20, 4)
      entry.writeUInt16LE(20, 6)
      entry.writeUInt16LE(UTF8, 8)
      entry.writeUInt16LE(stored ? 0 : 8, 10)
      entry.writeUInt16LE(stamp.time, 12)
      entry.writeUInt16LE(stamp.date, 14)
      entry.writeUInt32LE(crc, 16)
      entry.writeUInt32LE(body.length, 20)
      entry.writeUInt32LE(data.length, 24)
      entry.writeUInt16LE(name.length, 28)
      entry.writeUInt32LE(offset, 42)
      central.push(entry, name)
      write(local)
      write(name)
      write(body)
    }
    const start = offset
    for (const part of central) write(part)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(offset - start, 12)
    end.writeUInt32LE(start, 16)
    write(end)
  } finally {
    fs.closeSync(fd)
  }
  return files.length
}
