import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OUTDOOR_SPACE, roomRect, toPx } from '../grid'
import type { Ground } from '../pixel/terrain'

const KIT_URL = new URL('../../assets/river-kit.glb', import.meta.url).href

type Detail = { asset: string; x: number; z: number; width: number; depth: number }
type Tree = { fallback: THREE.Object3D; x: number; z: number; width: number }

/** 只选道路、门口、落脚点和已有树以外的留白；艺术品不改变地图及存档坐标。 */
function detailsFor(ground: Ground): Detail[] {
  const { atlas, width, wet, path, decor } = ground
  const rooms = atlas.spaces.filter((s) => s.id !== OUTDOOR_SPACE).map(roomRect)
  const points = [...atlas.stations, ...atlas.props].filter((p) => p.space === OUTDOOR_SPACE)
  const out: Detail[] = []
  const clear = (x: number, z: number, half: number) => {
    if (
      rooms.some(
        (r) =>
          x + half > r.x - 48 && x - half < r.x1 + 48 && z + half > r.y - 48 && z - half < r.y1 + 48
      )
    )
      return false
    if (points.some((p) => Math.hypot(x - p.x, z - p.y) < half + 70)) return false
    if (
      decor.vegetation.some(
        (p) => p.kind.startsWith('tree') && Math.hypot(x - p.x, z - p.y) < half + 80
      )
    )
      return false
    if (out.some((p) => Math.hypot(x - p.x, z - p.z) < half + p.width * 0.65)) return false
    // 包含四角的完整脚印检查，防止大件跨过窄路或伸进水中。
    for (let pz = toPx(z - half - 30); pz <= toPx(z + half + 30); pz++)
      for (let px = toPx(x - half - 30); px <= toPx(x + half + 30); px++) {
        const i = pz * width + px
        if (px < 0 || px >= width || pz < 0 || pz >= ground.height || wet[i] || path[i])
          return false
      }
    return true
  }
  const add = (
    kind: string,
    asset: string,
    size: number,
    targetX = 0,
    targetZ = 0,
    fallbackSize?: number
  ) => {
    const region = atlas.regions
      .filter((r) => r.kind === kind)
      .sort((a, b) => b.cells.length - a.cells.length)[0]
    if (!region?.cells.length) return
    const cx =
      region.cells.reduce((sum, [x]) => sum + (x + 0.5) * region.cell_size, 0) / region.cells.length
    const cz =
      region.cells.reduce((sum, [, z]) => sum + (z + 0.5) * region.cell_size, 0) /
      region.cells.length
    const candidates = region.cells
      .map(([x, z]) => [(x + 0.5) * region.cell_size, (z + 0.5) * region.cell_size])
      .sort(
        (a, b) =>
          Math.hypot(a[0] - cx - targetX, a[1] - cz - targetZ) -
          Math.hypot(b[0] - cx - targetX, b[1] - cz - targetZ)
      )
    // The original garden has narrow clear pockets. A small pavilion may fit where the
    // full garden house cannot; retain all clearance rules instead of placing across paths.
    for (const width of fallbackSize === undefined ? [size] : [size, fallbackSize]) {
      const spot = candidates.find(([x, z]) => clear(x, z, width / 2))
      if (!spot) continue
      out.push({ asset, x: spot[0], z: spot[1], width, depth: width })
      break
    }
  }
  add('plaza', 'RiverFountain', 88, 90, -60)
  add('garden', 'RiverGardenPavilion', 170, 70, -100, 130)
  add('plaza', 'RiverFlowerBoxes', 62, -170, 60)
  add('garden', 'RiverFlowerBoxes', 64, -140, 80)
  add('park', 'RiverMossRocks', 85, -100, 120)
  return out
}

/** Blender 导出的场景零件库。加载完成才换下原树，失败或晚到不破坏原地图。 */
export class RiverArt {
  private readonly group = new THREE.Group()
  private source?: THREE.Group
  private readonly trees: Tree[] = []
  private readonly details: Detail[]
  private readonly placed: Detail[] = []
  private disposed = false
  private loaded = false
  readonly enabled: boolean

  constructor(
    scene: THREE.Scene,
    ground: Ground,
    private readonly changed: () => void
  ) {
    this.enabled = ground.theme.id === 'village'
    this.details = this.enabled ? detailsFor(ground) : []
    this.group.name = 'River art · Blender'
    scene.add(this.group)
    if (!this.enabled) return
    void new GLTFLoader()
      .loadAsync(KIT_URL)
      .then((gltf) => {
        this.source = gltf.scene
        if (this.disposed) {
          this.releaseSource()
          return
        }
        gltf.scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return
          object.castShadow = object.receiveShadow = true
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          for (const material of materials) {
            for (const value of Object.values(material))
              if (value instanceof THREE.Texture) {
                value.magFilter = THREE.NearestFilter
                value.minFilter = THREE.LinearMipmapLinearFilter
                value.anisotropy = 2
                value.needsUpdate = true
              }
          }
        })
        for (const p of this.details) this.place(p)
        this.placeTrees()
        this.loaded = true
        this.changed()
      })
      .catch((error: unknown) => console.warn('河岸美术素材未能加载，继续使用原有像素场景', error))
  }

  /** 新艺术品在地图可走留白里占地时，化身点击选路也避开实际脚印。 */
  get obstacles() {
    return this.loaded ? this.placed : []
  }

  reserve(open: Uint8Array, width: number) {
    for (const p of this.details) {
      const half = p.width / 2 + 24
      for (let z = toPx(p.z - half); z <= toPx(p.z + half); z++)
        for (let x = toPx(p.x - half); x <= toPx(p.x + half); x++)
          if (x >= 0 && x < width && z >= 0 && z * width + x < open.length) open[z * width + x] = 0
    }
  }

  /** 复用原装饰树的位置和占地；优先换大树，灌木和远处小树继续用原立牌。 */
  tree(fallback: THREE.Object3D, x: number, z: number, width: number) {
    if (this.enabled && width >= 110 && this.trees.length < 100)
      this.trees.push({ fallback, x, z, width })
  }

  private asset(name: string) {
    return this.source?.getObjectByName(name)
  }

  private place(p: Detail) {
    const source = this.asset(p.asset)
    if (!source) return
    const object = source.clone(true)
    object.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(object),
      size = box.getSize(new THREE.Vector3())
    const scale = Math.min(p.width / size.x, p.depth / size.z)
    if (!Number.isFinite(scale) || scale <= 0) return
    const wrapper = new THREE.Group()
    object.position.add(
      new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
    )
    wrapper.add(object)
    wrapper.scale.setScalar(scale)
    wrapper.position.set(p.x, 0.5, p.z)
    this.group.add(wrapper)
    this.placed.push(p)
  }

  private placeTrees() {
    const source = this.asset('RiverOak')
    if (!source || !this.trees.length) return
    source.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(source),
      size = box.getSize(new THREE.Vector3())
    // Keep the glTF root's complete coordinate conversion. Cancelling matrixWorld here
    // would turn a future Z-up library root sideways while bounds still used Y-up space.
    const anchor = source.getWorldPosition(new THREE.Vector3())
    const normalize = new THREE.Matrix4().makeTranslation(-anchor.x, -box.min.y, -anchor.z)
    const pose = new THREE.Object3D()
    const breadth = Math.max(size.x, size.z)
    if (!Number.isFinite(breadth) || breadth <= 0) return
    let parts = 0
    source.traverse((part) => {
      if (!(part instanceof THREE.Mesh)) return
      const instances = new THREE.InstancedMesh(part.geometry, part.material, this.trees.length)
      const relative = normalize.clone().multiply(part.matrixWorld)
      for (let i = 0; i < this.trees.length; i++) {
        const p = this.trees[i]
        pose.position.set(p.x, 0, p.z)
        pose.scale.setScalar(p.width / breadth)
        pose.rotation.y = (i * 2.39996) % (Math.PI * 2)
        pose.updateMatrix()
        instances.setMatrixAt(i, pose.matrix.clone().multiply(relative))
      }
      instances.castShadow = instances.receiveShadow = true
      instances.computeBoundingSphere()
      this.group.add(instances)
      parts++
    })
    if (parts) for (const p of this.trees) p.fallback.visible = false
  }

  private releaseSource() {
    const geometry = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>(),
      textures = new Set<THREE.Texture>()
    this.source?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      geometry.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material)
    })
    for (const material of materials) {
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value)
      material.dispose()
    }
    for (const item of geometry) item.dispose()
    for (const texture of textures) texture.dispose()
    this.source = undefined
  }

  dispose() {
    this.disposed = true
    this.group.removeFromParent()
    this.group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose()
    })
    for (const p of this.trees) p.fallback.visible = true
    this.releaseSource()
  }
}
