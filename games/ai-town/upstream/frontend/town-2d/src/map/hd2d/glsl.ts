// 着色器里共用的一段：格点哈希和按它插值的数值噪声（0～1）。
// prefix 是函数名前缀；各材质拼自己的一份，同一个着色器里拼进两份也不重名。
export const hashNoise = (prefix: string) => /* glsl */ `
float ${prefix}Hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ${prefix}Noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(${prefix}Hash(i), ${prefix}Hash(i + vec2(1.0, 0.0)), f.x),
             mix(${prefix}Hash(i + vec2(0.0, 1.0)), ${prefix}Hash(i + vec2(1.0, 1.0)), f.x), f.y);
}`
