//! 时段名、三餐时段、日期换算。全部按时间查表，没有随机源进内核。

use crate::topology::MealWindow;
use crate::{time_of_day, DAY};

#[derive(Clone, Copy)]
enum Period {
    Dawn,
    Morning,
    Noon,
    Afternoon,
    Evening,
    Night,
}

impl Period {
    fn at(minutes: f64) -> Self {
        let t = time_of_day(minutes);
        if t < 360.0 {
            Self::Dawn
        } else if t < 660.0 {
            Self::Morning
        } else if t < 810.0 {
            Self::Noon
        } else if t < 1050.0 {
            Self::Afternoon
        } else if t < 1200.0 {
            Self::Evening
        } else {
            Self::Night
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Dawn => "凌晨",
            Self::Morning => "上午",
            Self::Noon => "晌午",
            Self::Afternoon => "下午",
            Self::Evening => "傍晚",
            Self::Night => "夜里",
        }
    }
}

pub fn period(minutes: f64) -> &'static str {
    Period::at(minutes).name()
}

/// 此刻在供餐时段内的那一餐；不在时段内为 None。表为空（测试拓扑）= 不限时。
pub fn meal_at(meals: &[MealWindow], minutes: f64) -> Option<&MealWindow> {
    let t = time_of_day(minutes);
    meals.iter().find(|m| t >= m.start && t < m.end)
}

pub fn day_index(minutes: f64) -> i64 {
    (minutes / DAY).floor() as i64
}
