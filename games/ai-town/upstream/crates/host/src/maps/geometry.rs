//! 二维几何原语。generated 用 SVG 单位，spatial 取米制的 x/z 平面，两边共用同一个容差。

pub(super) type Point = [f64; 2];

/// 位置比较容差。SVG 单位与米共用这一个值。
pub(super) const EPS: f64 = 0.001;
/// 线段相交判定里平行判断与参数范围的容差。
const CROSSING_EPS: f64 = 0.000_001;

/// 两点距离，二维与三维通用。
pub(super) fn distance<const N: usize>(a: [f64; N], b: [f64; N]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f64>()
        .sqrt()
}

/// 轴对齐矩形，x/y 是最小角。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    /// 点在矩形内，边界外扩 EPS。
    pub fn contains(&self, p: Point) -> bool {
        p[0] >= self.x - EPS
            && p[0] <= self.x + self.w + EPS
            && p[1] >= self.y - EPS
            && p[1] <= self.y + self.h + EPS
    }

    /// 点在矩形内，边界不留容差。
    pub fn contains_exact(&self, p: Point) -> bool {
        p[0] >= self.x && p[0] <= self.x + self.w && p[1] >= self.y && p[1] <= self.y + self.h
    }

    /// 两个矩形有面积重叠；只贴边不算。
    pub fn overlaps(&self, other: &Rect) -> bool {
        self.x < other.x + other.w - EPS
            && self.x + self.w > other.x + EPS
            && self.y < other.y + other.h - EPS
            && self.y + self.h > other.y + EPS
    }

    /// 四边各向外扩 d。
    pub fn expanded(&self, d: f64) -> Rect {
        Rect {
            x: self.x - d,
            y: self.y - d,
            w: self.w + 2.0 * d,
            h: self.h + 2.0 * d,
        }
    }

    /// 线段 a-b 进入矩形内部；边界向内收 EPS，贴边经过不算。
    pub fn crossed_by(&self, a: Point, b: Point) -> bool {
        let mut lo: f64 = 0.0;
        let mut hi: f64 = 1.0;
        for (axis, start, size) in [(0, self.x, self.w), (1, self.y, self.h)] {
            let delta = b[axis] - a[axis];
            if delta.abs() < EPS {
                if a[axis] <= start + EPS || a[axis] >= start + size - EPS {
                    return false;
                }
            } else {
                let u = (start + EPS - a[axis]) / delta;
                let v = (start + size - EPS - a[axis]) / delta;
                lo = lo.max(u.min(v));
                hi = hi.min(u.max(v));
                if lo >= hi {
                    return false;
                }
            }
        }
        hi > 0.0 && lo < 1.0
    }
}

fn cross(a: Point, b: Point) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn subtract(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}

/// 两条线段的包围盒是否分离，用于交叉检查前的快速排除。
pub(super) fn bounds_disjoint(a: (Point, Point), b: (Point, Point)) -> bool {
    (0..2)
        .any(|k| a.0[k].max(a.1[k]) < b.0[k].min(b.1[k]) || b.0[k].max(b.1[k]) < a.0[k].min(a.1[k]))
}

/// 两条线段的交点；平行或不相交返回 None。
pub(super) fn segment_intersection(a: (Point, Point), b: (Point, Point)) -> Option<Point> {
    let r = subtract(a.1, a.0);
    let s = subtract(b.1, b.0);
    let d = cross(r, s);
    if d.abs() < CROSSING_EPS {
        return None;
    }
    let offset = subtract(b.0, a.0);
    let t = cross(offset, s) / d;
    let u = cross(offset, r) / d;
    let range = -CROSSING_EPS..=1.0 + CROSSING_EPS;
    if !range.contains(&t) || !range.contains(&u) {
        return None;
    }
    Some([a.0[0] + t * r[0], a.0[1] + t * r[1]])
}
