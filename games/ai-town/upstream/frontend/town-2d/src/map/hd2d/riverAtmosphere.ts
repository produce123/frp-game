import * as THREE from 'three'
import { fromPx, PIXEL, toPx } from '../grid'
import { noise, rng } from '../pixel/noise'
import type { Ground } from '../pixel/terrain'
import type { HazeUniforms } from './horizon'

type Instance = {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  turn?: number
  color?: string
}
type CoastPoint = { x: number; z: number; nx: number; nz: number }

/** A horizontal, broken-edged ledge, with separate strata rather than a rounded pebble. */
function ledgeGeometry(moss = false) {
  const count = 11
  const rings = moss
    ? [
        [0.84, 0.58],
        [0.82, 0.68],
        [0, 0.7],
      ]
    : [
        [0.76, -0.64],
        [1, -0.36],
        [0.91, 0.15],
        [0.85, 0.57],
      ]
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = []
  for (const [radius, height] of rings) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      const edge = 1 + Math.sin(i * 8.1) * 0.13 + Math.cos(i * 2.7) * 0.06
      const x = Math.cos(angle) * radius * edge,
        z = Math.sin(angle) * radius * edge
      positions.push(x, height + Math.sin(i * 2.1) * 0.045, z)
      uvs.push((x + 1) * 0.5, (z + height + 2) * 0.4)
    }
  }
  for (let r = 0; r < rings.length - 1; r++)
    for (let i = 0; i < count; i++) {
      const a = r * count + i,
        b = r * count + ((i + 1) % count)
      indices.push(a, b + count, b, a, a + count, b + count)
    }
  if (!moss)
    for (let i = 1; i < count - 1; i++) indices.push(3 * count, 3 * count + i + 1, 3 * count + i)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  const flat = geometry.toNonIndexed()
  geometry.dispose()
  flat.computeVertexNormals()
  return flat
}

/** Jagged tier outlines keep the fir silhouette botanical even without a sprite. */
function firGeometry() {
  const positions: number[] = [],
    indices: number[] = []
  const count = 12
  for (const [radius, height] of [
    [1, 0],
    [0.72, 0.2],
    [0.65, 0.22],
    [0.4, 0.57],
    [0, 1],
  ]) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      const jag = i % 2 ? 0.85 : 1.08
      positions.push(Math.cos(angle) * radius * jag, height, Math.sin(angle) * radius * jag)
    }
  }
  for (let r = 0; r < 4; r++)
    for (let i = 0; i < count; i++) {
      const a = r * count + i,
        b = r * count + ((i + 1) % count)
      indices.push(a, a + count, b, b, a + count, b + count)
    }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  const flat = geometry.toNonIndexed()
  geometry.dispose()
  flat.computeVertexNormals()
  return flat
}

/** Long narrow leaves are solid folded triangles, readable from both camera presets. */
function leafGeometry() {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, 0, -0.09, 0.4, 0.1, 0, 1, 0.46, 0, 0, 0, 0, 1, 0.46, 0.09, 0.4, 0.1],
      3
    )
  )
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The playable floor stays at y=0. These ledges, plants and forest ridges only occupy the
 * sea outside its dry mask, so the approved terrace composition does not falsify paths,
 * house entrances, collisions or saved resident positions. There is deliberately an open
 * southern center: two planted foreground wings frame the town instead of hiding it.
 */
export class RiverAtmosphere {
  readonly group = new THREE.Group()
  private readonly materials: THREE.MeshLambertMaterial[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly stone?: THREE.MeshLambertMaterial

  constructor(scene: THREE.Scene, ground: Ground, haze?: HazeUniforms) {
    this.group.name = 'river-terrace-atmosphere'
    if (ground.theme.id !== 'village') return
    scene.add(this.group)
    const random = rng(ground.seed + 17291)
    const stone = this.material('#8c8d78', haze)
    this.stone = stone
    const moss = this.material('#718045', haze)
    const bark = this.material('#5f5239', haze)
    const leaves = this.material('#557038', haze)
    const reeds = this.material('#87954b', haze)
    reeds.side = THREE.DoubleSide
    const flowers = this.material('#ede4bb', haze)
    const ledge = this.geometry(ledgeGeometry())
    const cap = this.geometry(ledgeGeometry(true))
    const crown = this.geometry(new THREE.IcosahedronGeometry(1, 1))
    const trunk = this.geometry(new THREE.CylinderGeometry(0.65, 1, 1, 6))
    const fir = this.geometry(firGeometry())
    const blade = this.geometry(leafGeometry())
    const rocks: Instance[] = [],
      caps: Instance[] = [],
      branches: Instance[] = []
    const crowns: Instance[] = [],
      needles: Instance[] = [],
      grasses: Instance[] = [],
      blooms: Instance[] = []
    const dry = (x: number, z: number) => {
      const px = toPx(x),
        pz = toPx(z)
      return (
        px >= 0 &&
        pz >= 0 &&
        px < ground.width &&
        pz < ground.height &&
        !ground.wet[pz * ground.width + px]
      )
    }
    const coast: CoastPoint[] = []
    let x0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      z1 = -Infinity
    // Sample at six terrain pixels. Even large generated towns remain a bounded effect.
    for (let pz = 1; pz < ground.height - 1; pz += 6)
      for (let px = 1; px < ground.width - 1; px += 6) {
        if (ground.wet[pz * ground.width + px]) continue
        const x = fromPx(px),
          z = fromPx(pz)
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        z0 = Math.min(z0, z)
        z1 = Math.max(z1, z)
        let nx = 0,
          nz = 0
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          if (!dry(x + dx * PIXEL * 7, z + dz * PIXEL * 7)) {
            nx += dx
            nz += dz
          }
        }
        const length = Math.hypot(nx, nz)
        if (length) coast.push({ x, z, nx: nx / length, nz: nz / length })
      }
    if (!Number.isFinite(x0)) return
    const width = x1 - x0,
      depth = z1 - z0,
      cx = (x0 + x1) / 2
    const isClearWater = (x: number, z: number, radius: number) => {
      if (dry(x, z)) return false
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        if (dry(x + Math.cos(a) * radius, z + Math.sin(a) * radius)) return false
      }
      return !ground.docks.some((d) => Math.hypot(x - d.x, z - d.y) < radius + d.length + 80)
    }
    const rock = (x: number, z: number, radius: number, height: number, y = 0) => {
      const instance = {
        x,
        y,
        z,
        sx: radius,
        sy: height,
        sz: radius * (0.6 + random() * 0.25),
        turn: random() * Math.PI,
      }
      rocks.push({
        ...instance,
        color: ['#858774', '#777b6d', '#9a9780'][Math.floor(random() * 3)],
      })
      caps.push({ ...instance, color: ['#728046', '#899452', '#627540'][Math.floor(random() * 3)] })
    }
    const plant = (x: number, z: number, y: number, size: number, flowering = false) => {
      const count = 4 + Math.floor(random() * 4)
      for (let i = 0; i < count; i++) {
        const h = size * (0.6 + random() * 0.6),
          a = (i / count) * Math.PI * 2
        grasses.push({ x, y, z, sx: h, sy: h, sz: h, turn: a })
        if (flowering && i % 2 === 0)
          blooms.push({
            x: x + Math.sin(a) * h * 0.46,
            y: y + h,
            z: z + Math.cos(a) * h * 0.46,
            sx: 3.2,
            sy: 2,
            sz: 3.2,
            color: i % 4 ? '#e1d7af' : '#e9b6ae',
          })
      }
    }
    const tree = (x: number, z: number, y: number, height: number, pine = false) => {
      branches.push({
        x,
        y: y + height * 0.38,
        z,
        sx: height * 0.045,
        sy: height * 0.76,
        sz: height * 0.045,
      })
      if (pine) {
        for (let tier = 0; tier < 3; tier++) {
          const scale = 1 - tier * 0.23
          needles.push({
            x,
            y: y + height * (0.16 + tier * 0.19),
            z,
            sx: height * 0.28 * scale,
            sy: height * 0.48 * scale,
            sz: height * 0.28 * scale,
            turn: tier * 0.9,
            color: tier === 2 ? '#6e8248' : '#405e3e',
          })
        }
      } else {
        for (let lobe = 0; lobe < 6; lobe++) {
          const a = lobe * 2.4,
            spread = lobe ? height * 0.19 : 0
          crowns.push({
            x: x + Math.sin(a) * spread,
            y: y + height * (lobe ? 0.64 : 0.84),
            z: z + Math.cos(a) * spread,
            sx: height * (0.22 + random() * 0.06),
            sy: height * (0.24 + random() * 0.06),
            sz: height * 0.25,
            turn: a,
            color: ['#4c6837', '#697c3e', '#7e8c45'][lobe % 3],
          })
        }
      }
    }
    // Mineral outcrops form three broad rhythm changes around the coast, not an even wall.
    const used: { x: number; z: number; radius: number }[] = []
    for (let i = 0; i < coast.length && used.length < 64; i++) {
      const p = coast[i]
      if (noise(p.x / 480, p.z / 480, ground.seed) < 0.49 || random() > 0.24) continue
      const radius = 42 + random() * 62
      const x = p.x + p.nx * (radius * 1.25 + PIXEL * 3),
        z = p.z + p.nz * (radius * 1.25 + PIXEL * 3)
      if (
        !isClearWater(x, z, radius * 1.2) ||
        used.some((q) => Math.hypot(x - q.x, z - q.z) < radius + q.radius * 0.7)
      )
        continue
      used.push({ x, z, radius })
      const height = 20 + random() * 34
      rock(x, z, radius, height)
      if (random() > 0.38) plant(x, z, height * 0.72, 18 + random() * 23, random() > 0.6)
      if (random() > 0.5)
        rock(x + p.nx * radius * 0.9, z + p.nz * radius * 0.9, radius * 0.45, height * 0.45, -4)
    }
    // Close bank wings: the left mass is taller; the right is low reeds and flowering stone.
    for (const side of [-1, 1]) {
      const target = cx + side * width * 0.24
      const south = coast
        .filter((p) => p.nz > 0.4 && Math.abs(p.x - target) < width * 0.1)
        .sort((a, b) => Math.abs(a.x - target) - a.z * 0.15 - (Math.abs(b.x - target) - b.z * 0.15))
        .find((p) => isClearWater(p.x + side * 120, p.z + 260, 145))
      if (!south) continue
      const wingX = south.x + side * 120,
        wingZ = south.z + 260
      if (!isClearWater(wingX, wingZ, 145)) continue
      for (let k = 0; k < 5; k++) {
        const x = wingX + side * k * 85,
          z = wingZ + Math.sin(k * 1.4) * 38
        if (!isClearWater(x, z, 115)) continue
        const height = 48 + random() * 25
        rock(x, z, 125 - k * 9, height)
        for (let p = 0; p < 5; p++)
          plant(
            x + (random() - 0.5) * 110,
            z + (random() - 0.5) * 80,
            height * 0.7,
            38 + random() * 34,
            p % 3 === 0
          )
        if (k === 2) tree(x + side * 35, z + 12, height * 0.7, side < 0 ? 330 : 220, side > 0)
      }
    }
    this.instances(ledge, stone, rocks)
    this.instances(cap, moss, caps)
    this.instances(trunk, bark, branches)
    this.instances(crown, leaves, crowns)
    this.instances(fir, leaves, needles)
    this.instances(blade, reeds, grasses)
    this.instances(crown, flowers, blooms)

    // Three receding forest banks have distinct heights, valleys and haze; their land is
    // entirely north of the playable mask. Real geometry keeps the overhead view coherent.
    for (let layer = 0; layer < 3; layer++) {
      const distant = this.material(
        layer === 0 ? '#586d4b' : layer === 1 ? '#71816a' : '#839085',
        haze,
        0.12 + layer * 0.12
      )
      const forestFloor = this.material(
        layer === 0 ? '#70834b' : layer === 1 ? '#7c8e65' : '#8d9b7c',
        haze,
        0.1 + layer * 0.11
      )
      const hills: Instance[] = [],
        forest: Instance[] = []
      const layerZ = z0 - 430 - layer * Math.max(500, depth * 0.15)
      for (let bank = 0; bank < 5; bank++) {
        const x = cx + (bank - 2) * width * 0.29 + Math.sin(bank * 2.9 + layer) * 180
        const h = (layer + 1) * 65 + 50 + random() * 45
        const radius = width * (0.14 + random() * 0.04)
        const bankZ = layerZ - Math.cos(bank * 1.3) * 120
        const bankDepth = 240 + layer * 100
        hills.push({
          x,
          y: h * 0.1,
          z: bankZ,
          sx: radius,
          sy: h * 1.2,
          sz: bankDepth,
          // Keep the long axis east/west: rotating this elongated bank could project
          // back across the playable north shore even with its center safely outside.
          turn: 0,
        })
        // Two staggered, overlapping rows read as one woodland mass after depth blur;
        // isolated small firs disappear and leave the bare bank looking like a slab.
        for (let n = 0; n < 26; n++) {
          const row = Math.floor(n / 13)
          const t = ((n % 13) + 0.35 + row * 0.3) / 13,
            tx = x + (t - 0.5) * radius * 1.6 + (random() - 0.5) * 60
          // Valley in the central far bank lets the existing sky and mountain silhouette breathe.
          if (bank === 2 && t > 0.38 && t < 0.63 && layer > 0) continue
          const height = 240 + random() * 160
          const tz = bankZ + (row - 0.5) * 125 + (random() - 0.5) * 50
          // Follow the rounded bank instead of putting every trunk on a flat shelf.
          // A slight burial keeps roots inside the faceted approximation of the ellipsoid.
          const surface = Math.sqrt(
            Math.max(0, 1 - ((tx - x) / radius) ** 2 - ((tz - bankZ) / bankDepth) ** 2)
          )
          forest.push({
            x: tx,
            y: h * (0.1 + 1.02 * surface),
            z: tz,
            sx: height * (0.29 + random() * 0.045),
            sy: height,
            sz: height * 0.28,
            turn: random() * 5,
            color: n % 3 === 0 ? '#6c7c54' : '#4e694f',
          })
        }
      }
      // These are softly rounded green knolls, not the flat-topped rock shelves used at
      // the near coast. Their side silhouette must remain woodland in the overhead view.
      this.instances(crown, forestFloor, hills, false)
      this.instances(fir, distant, forest, false)
    }
  }

  private geometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry)
    return geometry
  }

  private material(color: string, haze?: HazeUniforms, base = 0) {
    const material = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0 })
    if (haze) {
      // Horizon.addHaze predates instanced scenery. Include instanceMatrix here so each
      // individual tree enters the same existing haze field at its actual world depth.
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, {
          uRiverHaze: haze.uHaze,
          uRiverHorizon: haze.uHorizon,
          uRiverHazeLen: haze.uHazeLen,
          uRiverDirection: haze.uHazeDirection,
        })
        shader.vertexShader =
          'varying float vRiverZ; uniform vec2 uRiverDirection;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
          vec4 riverWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            riverWorld = instanceMatrix * riverWorld;
          #endif
          vRiverZ = dot((modelMatrix * riverWorld).xz, uRiverDirection);
        `
          )
        shader.fragmentShader =
          'varying float vRiverZ; uniform vec3 uRiverHaze; uniform float uRiverHorizon; uniform float uRiverHazeLen;\n' +
          shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>
          float riverFog = clamp(1.0 - (vRiverZ - uRiverHorizon) / uRiverHazeLen, 0.0, 1.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uRiverHaze, max(${base.toFixed(2)}, riverFog * riverFog * 0.46));
        `
          )
      }
      material.customProgramCacheKey = () => `river-atmosphere-${base}`
    }
    this.materials.push(material)
    return material
  }

  private instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    items: Instance[],
    shadows = true
  ) {
    if (!items.length) return
    const mesh = new THREE.InstancedMesh(geometry, material, items.length)
    const dummy = new THREE.Object3D(),
      white = new THREE.Color('#ffffff'),
      color = new THREE.Color()
    for (let i = 0; i < items.length; i++) {
      const p = items[i]
      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.set(p.sx, p.sy, p.sz)
      dummy.rotation.y = p.turn ?? 0
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      // Instance color is a modest variation; the shared palette still defines the material.
      mesh.setColorAt(i, p.color ? color.set(p.color).lerp(white, 0.6) : white)
    }
    mesh.castShadow = shadows
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    this.group.add(mesh)
  }

  /** Optional generated, tileable stone/moss art; ownership remains with the scene loader. */
  setSurfaceTexture(texture: THREE.Texture) {
    if (!this.stone) return
    this.stone.map = texture
    this.stone.needsUpdate = true
  }

  setLight(day: number) {
    for (const material of this.materials)
      material.emissiveIntensity = (1 - Math.max(0, Math.min(1, day))) * 0.025
  }

  dispose() {
    this.group.removeFromParent()
    this.group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose()
    })
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
  }
}
