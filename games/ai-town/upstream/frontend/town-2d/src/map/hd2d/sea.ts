import * as THREE from 'three'
import { MARGIN, PIXEL } from '../grid'
import { MAX_DEPTH } from '../pixel/island'
import { hashNoise } from './glsl'
import { addHaze, type HazeUniforms } from './horizon'
import type { MapTheme } from '../themes/types'

// 海面：一整块平面垫在地面下面，地面贴图上水的像素是透明的，露出海。
// 颜色按离岸像素数分档（近岸浅青、远处深蓝），档与档之间按像素交错；
// 近岸一道道浪线往岸上推，紧贴岸的一圈白沫闪动，深水里有成段的浪纹慢慢漂，偶尔几点闪光。
// 外海有大片深浅不一的色斑和几处浅滩；越往北越融进海雾，直到海平线。
// 全部按地图像素格取整，时间也按每秒 6 步走，保持像素风。
// 废土里同一块平面画成干海床：离旧海岸越远越平、越白；成片龟裂、盐壳、旧水位线，零星碎贝壳。
// 冰雪里画成冰原：近岸冻得厚、发白，越远越蓝；近岸一圈碎浮冰，成片积雪、风吹雪纹、断续的冰堆，冰面偶尔一点反光。

const HEADER = /* glsl */ `
uniform sampler2D uDepth;
uniform float uTime;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform float uPixel;
varying vec2 vSeaPos;
${hashNoise('sea')}
vec3 seaHex(vec3 c) { return pow(c / 255.0, vec3(2.2)); }
// 泰森多边形：返回到最近两个格点的距离和最近那一格的编号（0～1），冰面的浮冰块用
vec3 seaCells(vec2 cell, float size) {
  vec2 g = floor(cell / size);
  float f1 = 1e9, f2 = 1e9, id = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o = g + vec2(float(i), float(j));
      vec2 p = (o + vec2(seaHash(o), seaHash(o + 17.0))) * size;
      float dist = length(cell - p);
      if (dist < f1) { f2 = f1; f1 = dist; id = seaHash(o + 5.0); } else if (dist < f2) f2 = dist;
    }
  return vec3(f1, f2, id);
}
`

const COLOR = /* glsl */ `
  vec2 cell = floor(vSeaPos / uPixel);
  vec2 st = ((cell + 0.5) * uPixel - uOrigin) / uSize;
  float d = ${MAX_DEPTH.toFixed(1)};
  if (st.x >= 0.0 && st.y >= 0.0 && st.x <= 1.0 && st.y <= 1.0) d = texture2D(uDepth, st).r * 255.0;
  float t = floor(uTime * 6.0) / 6.0;
  float band = log2(d + 0.5) + seaHash(cell) * 0.8 - 0.2;
  // 外海：大片深浅色斑（海底起伏），零星几处浅滩
  float deep = clamp((d - 8.0) / 16.0, 0.0, 1.0);
  float blotch = seaNoise(cell / 140.0) * 0.7 + seaNoise(cell / 50.0 + 7.0) * 0.3;
  float shoal = smoothstep(0.93, 0.98, seaNoise(cell / 70.0 + 31.0) * 0.8 + seaNoise(cell / 18.0 + 5.0) * 0.2);
  band += deep * ((blotch - 0.5) * 1.1 - shoal * 2.0);
  band = clamp(band, 0.0, 5.0);
  vec3 c = band < 1.0 ? seaHex(uSeaBand[0])
    : band < 2.0 ? seaHex(uSeaBand[1])
    : band < 3.0 ? seaHex(uSeaBand[2])
    : band < 4.0 ? seaHex(uSeaBand[3])
    : band < 5.0 ? seaHex(uSeaBand[4])
    : seaHex(uSeaBand[5]);
  vec3 foam = seaHex(uFoam);
  // 往岸上推的浪线：相位随时间增加，同一相位的线离岸越来越近
  float wave = fract((d + t * 1.4) / 5.0);
  if (d < 8.0 && wave < 0.16 && seaHash(floor(cell / 3.0) + floor(t * 0.5)) > 0.2)
    c = mix(c, foam, 0.7 * (1.0 - d / 8.0));
  if (d < 1.5 && seaHash(cell + floor(t * 2.0)) > 0.35) c = foam;
  // 深水里成段的浪纹，每三行一条，各行漂的方向和快慢不同
  float lane = floor(cell.y / 3.0);
  float drift = cell.x + t * 4.0 * (seaHash(vec2(lane, 1.0)) - 0.5);
  if (d > 5.0 && mod(cell.y, 3.0) < 1.0 && seaHash(vec2(floor(drift / 7.0), lane)) > 0.8 &&
      fract(drift / 7.0) < 0.55)
    c = mix(c, seaHex(uRipple), 0.55);
  if (seaHash(cell + vec2(floor(t * 1.5) * 17.0, 3.0)) > 0.9975) c = seaHex(uGlint);
  diffuseColor.rgb = c;
`

const SEABED = /* glsl */ `
  vec2 cell = floor(vSeaPos / uPixel);
  vec2 st = ((cell + 0.5) * uPixel - uOrigin) / uSize;
  float d = ${MAX_DEPTH.toFixed(1)};
  if (st.x >= 0.0 && st.y >= 0.0 && st.x <= 1.0 && st.y <= 1.0) d = texture2D(uDepth, st).r * 255.0;
  float deep = clamp((d - 8.0) / 16.0, 0.0, 1.0);
  float blotch = seaNoise(cell / 140.0) * 0.7 + seaNoise(cell / 50.0 + 7.0) * 0.3;
  float band = log2(d + 0.5) + seaHash(cell) * 0.8 - 0.2 + deep * (blotch - 0.5) * 1.4;
  band = clamp(band, 0.0, 5.0);
  vec3 c = band < 1.0 ? uBand[0] : band < 2.0 ? uBand[1] : band < 3.0 ? uBand[2]
    : band < 4.0 ? uBand[3] : band < 5.0 ? uBand[4] : uBand[5];
  // 龟裂：泰森多边形，越远格子越大
  float size = 7.0 + deep * 6.0;
  vec2 g = floor(cell / size);
  float f1 = 1e9, f2 = 1e9;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o = g + vec2(float(i), float(j));
      vec2 p = (o + vec2(seaHash(o), seaHash(o + 17.0))) * size;
      float dist = length(cell - p);
      if (dist < f1) { f2 = f1; f1 = dist; } else if (dist < f2) f2 = dist;
    }
  bool cracked = f2 - f1 < 0.9 && seaNoise(cell / 40.0 + 3.0) > 0.35;
  // 盐壳：远处成片发白
  float salt = seaNoise(cell / 35.0 + 13.0) * 0.7 + seaNoise(cell / 9.0 + 5.0) * 0.3;
  if (deep > 0.3 && salt > 0.64) c = mix(c, uSalt, 0.3 + 0.15 * step(0.72, salt));
  // 旧水位线：离岸每隔 6 格一道浅痕，断断续续
  if (d < 22.0 && mod(floor(d), 6.0) == 0.0 && seaHash(floor(cell / 3.0)) > 0.35) c = mix(c, uSalt, 0.3);
  if (cracked) c *= 0.7;
  if (seaHash(cell + 11.0) > 0.994) c = uSalt * 1.08;
  diffuseColor.rgb = c;
`

const ICE = /* glsl */ `
  vec2 cell = floor(vSeaPos / uPixel);
  vec2 st = ((cell + 0.5) * uPixel - uOrigin) / uSize;
  float d = ${MAX_DEPTH.toFixed(1)};
  if (st.x >= 0.0 && st.y >= 0.0 && st.x <= 1.0 && st.y <= 1.0) d = texture2D(uDepth, st).r * 255.0;
  float deep = clamp((d - 4.0) / 20.0, 0.0, 1.0);
  float band = log2(d + 0.5) + seaHash(cell) * 0.8 - 0.2 + (seaNoise(cell / 60.0) - 0.5) * 1.2 * deep;
  band = clamp(band, 0.0, 5.0);
  vec3 c = band < 1.0 ? uBand[0] : band < 2.0 ? uBand[1] : band < 3.0 ? uBand[2]
    : band < 4.0 ? uBand[3] : band < 5.0 ? uBand[4] : uBand[5];
  // 积雪：大片横向拉长的白，边缘柔和，不碎成小块
  float snow = seaNoise(cell / vec2(110.0, 60.0) + 3.0) * 0.85 + seaNoise(cell / 34.0 + 9.0) * 0.15;
  if (snow > 0.64) c = mix(c, uSalt, snow > 0.68 ? 0.7 : 0.35);
  // 风吹雪纹：顺着东西向的细长淡痕，只在没有积雪的冰面上
  if (snow <= 0.64 && seaNoise(vec2(cell.x / 45.0, cell.y / 1.8) + 50.0) > 0.78) c = mix(c, uSalt, 0.22);
  // 近岸碎浮冰：离岸越近冰块越小，块与块之间露出深色水缝，往外合成整片冰
  if (d > 1.5 && d < 30.0) {
    float near = 1.0 - (d - 1.5) / 28.5;
    // 格子大小固定：随距离变的话相邻像素的格子对不上，边就断了
    vec3 floe = seaCells(cell, 7.0);
    c *= 0.96 + floe.z * 0.08;
    if (floe.y - floe.x < 0.9 && seaHash(floor(cell / 3.0) + 31.0) < near * 1.2) c = mix(c, uBand[5] * 0.78, 0.55);
  }
  // 冰堆：沿一条大尺度等值线挤起来的碎冰块，断断续续，每两格一块，亮面和背光面分开
  float ridge = abs(seaNoise(cell / 120.0 + 21.0) - 0.5);
  if (ridge < 0.012 && seaNoise(cell / 18.0 + 40.0) > 0.55) {
    float block = seaHash(floor(cell / 2.0) + 60.0);
    c = block > 0.55 ? mix(c, uSalt, 0.85) : block > 0.2 ? c * 0.82 : c;
  }
  if (d < 1.5) c = uSalt;
  // 冰面反光：稀疏的亮点，隔一会儿换一处
  if (seaHash(cell + vec2(floor(uTime * 3.0) * 7.0, 1.0)) > 0.9985) c = vec3(1.0);
  diffuseColor.rgb = c;
`

/** 外圈的材质：会动的海，或者干海床。depth 是地面画布每个像素离岸多远（像素），
 *  画布左上角在世界坐标 (-MARGIN, -MARGIN)；haze 是远景的海雾 */
export function outerMaterial(
  depth: Uint8Array,
  pw: number,
  ph: number,
  haze: HazeUniforms,
  theme: MapTheme
) {
  const map = new THREE.DataTexture(depth, pw, ph, THREE.RedFormat, THREE.UnsignedByteType)
  map.magFilter = map.minFilter = THREE.NearestFilter
  map.needsUpdate = true
  const time = { value: 0 }
  const surface = theme.ground.seaSurface
  if (theme.outer === 'sea' && !surface) throw Error('外圈是海的风格包要给 ground.seaSurface')
  // 海的颜色按 0～255 交给着色器，在着色器里换算成线性值
  const raw = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return new THREE.Vector3(n >> 16, (n >> 8) & 255, n & 255)
  }
  const material = new THREE.MeshStandardMaterial({
    roughness: theme.outer === 'seabed' ? 1 : theme.outer === 'ice' ? 0.35 : 0.5,
    metalness: 0,
  })
  // 离岸距离贴图只放在着色器的 uniform 里，材质释放时一起释放
  material.addEventListener('dispose', () => map.dispose())
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uDepth: { value: map },
      uTime: time,
      uOrigin: { value: new THREE.Vector2(-MARGIN, -MARGIN) },
      uSize: { value: new THREE.Vector2(pw * PIXEL, ph * PIXEL) },
      uPixel: { value: PIXEL },
      uBand: { value: theme.ground.outer.map((c) => new THREE.Color(c)) },
      uSalt: { value: new THREE.Color(theme.ground.outerSpot ?? theme.ground.outer[5]) },
      uSeaBand: { value: theme.ground.outer.map(raw) },
      uFoam: { value: raw(surface?.foam ?? '#000000') },
      uRipple: { value: raw(surface?.ripple ?? '#000000') },
      uGlint: { value: raw(surface?.glint ?? '#000000') },
    })
    shader.vertexShader =
      'varying vec2 vSeaPos;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vSeaPos = (modelMatrix * vec4(transformed, 1.0)).xz;'
      )
    const body = theme.outer === 'seabed' ? SEABED : theme.outer === 'ice' ? ICE : COLOR
    shader.fragmentShader =
      HEADER +
      'uniform vec3 uBand[6];\nuniform vec3 uSalt;\n' +
      'uniform vec3 uSeaBand[6];\nuniform vec3 uFoam;\nuniform vec3 uRipple;\nuniform vec3 uGlint;\n' +
      shader.fragmentShader.replace('#include <map_fragment>', body)
    addHaze(shader, haze)
  }
  return { material, time }
}
