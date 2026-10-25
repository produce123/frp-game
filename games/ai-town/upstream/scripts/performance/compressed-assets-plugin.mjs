import { brotliCompressSync, gzipSync, constants } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
export function compressedAssetsPlugin() {
  return {
    name: 'compressed-production-assets',
    apply: 'build',
    async writeBundle(options, bundle) {
      // Read final output after Vite resolves preload markers and asset URLs.
      for (const asset of Object.values(bundle)) {
        if (!/\.(js|css|json)$/.test(asset.fileName)) continue
        const file = path.join(options.dir, asset.fileName)
        const source = await readFile(file)
        if (source.length < 1024) continue
        await writeFile(
          file + '.br',
          brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
        )
        await writeFile(file + '.gz', gzipSync(source))
      }
    },
  }
}
