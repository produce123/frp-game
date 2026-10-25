/** 弧长参数化的一条边：按 elapsed/total 取坐标。 */
export class EdgeCurve {
  private pts: [number, number][]
  private cum: number[]
  private total: number
  constructor(pts: [number, number][]) {
    this.pts = pts
    this.cum = [0]
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
      this.cum.push(this.cum[i - 1] + d)
    }
    this.total = this.cum[this.cum.length - 1] || 1
  }
  at(frac: number): [number, number] {
    const dist = Math.min(Math.max(frac, 0), 1) * this.total
    for (let i = 1; i < this.cum.length; i++) {
      if (this.cum[i] >= dist) {
        const seg = this.cum[i] - this.cum[i - 1] || 1
        const t = (dist - this.cum[i - 1]) / seg
        return [
          this.pts[i - 1][0] + (this.pts[i][0] - this.pts[i - 1][0]) * t,
          this.pts[i - 1][1] + (this.pts[i][1] - this.pts[i - 1][1]) * t,
        ]
      }
    }
    return this.pts[this.pts.length - 1]
  }
}
