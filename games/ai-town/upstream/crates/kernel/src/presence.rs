//! 在场名单：同一处所里的其他人，以及他们正在做的事。
//!
//! 这是可见范围里的第一档可及性：
//! 同处所 = 1.0。第二档（隔一条带「视」能力的通道）与显著性排序还没做，
//! 名单按 actor id 字典序，保证可复现。
//!
//! 名单从真实的 actors 表里查出来。只有一个村民时它恒为空，【周围】就报「没有别人」——
//! 这是数据算出来的结果，不是写死的字。

use crate::actor::Actors;

/// 在场的一个人：名字 + 正在做的事（动作词）。
#[derive(Debug, Clone, PartialEq)]
pub struct Present {
    pub name: String,
    pub verb: String,
}

/// 与 actor 同处所的其他人（不含本人），按 id 顺序。
pub(crate) fn others_here(actors: &Actors, actor_id: &str) -> Vec<Present> {
    let Some(me) = actors.get(actor_id) else {
        return Vec::new();
    };
    actors
        .values()
        .filter(|a| a.present() && a.id != actor_id && a.locus.locale == me.locus.locale)
        .map(|a| Present {
            name: a.name.clone(),
            verb: a.current.verb.clone(),
        })
        .collect()
}

/// 「阿花（整理花束）、老周（停留）」
pub(crate) fn list(others: &[Present]) -> String {
    others
        .iter()
        .map(|p| format!("{}（{}）", p.name, p.verb))
        .collect::<Vec<_>>()
        .join("、")
}
