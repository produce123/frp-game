import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { verifyClientBuild, writeClientBuildState } from '../client-build-state.mjs'

test('formal preview rejects missing and stale builds, accepts a rebuilt creator', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-build-state-'))
  try {
    const dist = path.join(root, 'frontend/town-2d/dist')
    const source = path.join(root, 'frontend/town-2d/main.ts')
    await fs.mkdir(dist, { recursive: true })
    await fs.writeFile(source, 'export const version = 1')
    await assert.rejects(verifyClientBuild(root))
    await fs.writeFile(path.join(dist, 'index.html'), '<main></main>')
    await fs.writeFile(path.join(dist, 'game.html'), '<main></main>')
    await writeClientBuildState(root, dist)
    await verifyClientBuild(root)
    await fs.writeFile(source, 'export const version = 2')
    await assert.rejects(verifyClientBuild(root))
    await writeClientBuildState(root, dist)
    await verifyClientBuild(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
