import * as THREE from 'three'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { CopyShader } from 'three/addons/shaders/CopyShader.js'

// 后期：真实表面深度控制前后景离焦，叠加原有上下边缘移轴模糊，再调色和暗角。
// 调色在色调映射之前的线性空间里做，对比度以中灰 0.18 为中心按幂次拉开，暗部不会变成负数。

/** 颜色和深度来自同一次场景绘制，保留树、村民的 alphaTest 和立牌自定义的深度。
 *  不用统一深度材质重画，否则透明边缘会变成矩形，人物也会和房屋遮挡不一致。
 *  独立目标在后续模糊期间保持只读，避免 composer 交换缓冲时覆盖深度或产生读写反馈。 */
export class SceneDepthPass extends RenderPass {
  captureDepth = true
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  })
  private readonly copy = new ShaderPass(CopyShader)

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super(scene, camera)
    this.copy.material.depthTest = false
    this.copy.material.depthWrite = false
    this.copy.material.blending = THREE.NoBlending
  }

  get depthTexture() {
    return this.target.depthTexture
  }

  override setSize(width: number, height: number) {
    this.target.setSize(width, height)
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean
  ) {
    if (!this.captureDepth) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
      return
    }
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive)
    this.copy.render(renderer, readBuffer, this.target, deltaTime, maskActive)
  }

  override dispose() {
    this.copy.dispose()
    this.target.dispose()
  }
}

const vertexShader =
  'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'

/** 移轴的清晰带在画面里的高度（从下往上 0～1）：地图没被面板盖住时稍低于正中 */
export const TILT_FOCUS = 0.48

/** 横竖各跑一遍的景深模糊，amount/depthAmount 是每一采样步的设备像素。
 *  深度用正交相机的线性距离，清晰区跟着未被面板遮住的地面中心走。 */
export const tiltShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    dir: { value: new THREE.Vector2(1, 0) },
    amount: { value: 2.6 },
    depthAmount: { value: 2.4 },
    cameraNear: { value: 0 },
    cameraFar: { value: 1 },
    focusDepth: { value: 0 },
    focusRange: { value: 1 },
    depthFalloff: { value: 1 },
    focus: { value: TILT_FOCUS },
    band: { value: 0.16 },
    res: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 dir;
uniform float amount;
uniform float depthAmount;
uniform float cameraNear;
uniform float cameraFar;
uniform float focusDepth;
uniform float focusRange;
uniform float depthFalloff;
uniform float focus;
uniform float band;
uniform vec2 res;
varying vec2 vUv;
float surfaceDepth(vec2 uv) {
  return mix(cameraNear, cameraFar, texture2D(tDepth, uv).r);
}
void main() {
  float depth = surfaceDepth(vUv);
  float edgeBlur = smoothstep(band, band + 0.38, abs(vUv.y - focus)) * amount;
  float depthBlur = smoothstep(focusRange, focusRange + depthFalloff,
    abs(depth - focusDepth)) * depthAmount;
  float radius = max(edgeBlur, depthBlur);
  vec4 color = vec4(0.);
  float total = 0.;
  for (int i = -7; i <= 7; i++) {
    vec2 uv = clamp(vUv + dir * float(i) * radius / res, 0.5 / res, 1. - 0.5 / res);
    float weight = exp(-float(i * i) / 24.);
    // 远景颜色不穿过清晰人物、屋檐与树叶的轮廓；近景仍保留柔和离焦。
    float boundary = smoothstep(focusRange * 0.5, focusRange * 2.,
      abs(surfaceDepth(uv) - depth));
    weight *= mix(1., 0.08, boundary);
    color += texture2D(tDiffuse, uv) * weight;
    total += weight;
  }
  gl_FragColor = color / total;
}`,
}

export const gradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tint: { value: new THREE.Color(1, 1, 1) },
    sat: { value: 1.18 },
    vignette: { value: 0.55 },
    lift: { value: new THREE.Color(0, 0, 0) },
    contrast: { value: 1 },
  },
  vertexShader,
  fragmentShader: `uniform sampler2D tDiffuse;uniform vec3 tint;uniform float sat;uniform float vignette;uniform vec3 lift;uniform float contrast;varying vec2 vUv;
void main(){vec4 c=texture2D(tDiffuse,vUv);float l=dot(c.rgb,vec3(.2126,.7152,.0722));c.rgb=mix(vec3(l),c.rgb,sat)*tint+lift;c.rgb=.18*pow(max(c.rgb,vec3(0.))/.18,vec3(contrast));
vec2 q=vUv-.5;q.x*=1.25;c.rgb*=mix(1.,smoothstep(.95,.25,length(q)),vignette);gl_FragColor=c;}`,
}
