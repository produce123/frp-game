use crate::common;
use kernel::{Topology, World};
use serde_json::json;

fn topology() -> Topology {
    common::two_places(serde_json::json!([
        {"id":"meal","name":"饭桌","locale":"loc_a","verbs":[{"verb":"吃饭","duration_minutes":10,"effects":{"饿":-2}}]},
        {"id":"bench_a","name":"工作台","locale":"loc_a","verbs":[{"verb":"制作器物","duration_minutes":10,"effects":{"累":1}}]},
        {"id":"bench_b","name":"工作台","locale":"loc_b","verbs":[{"verb":"制作器物","duration_minutes":10,"effects":{"累":1}}]}
    ]))
}
fn advance(w: &mut World, total: f64, step: f64) {
    let target = w.minutes() + total;
    while w.minutes() < target - 1e-8 {
        w.step(step.min(target - w.minutes()));
    }
}
/// 吃饭 10 分钟再干活 10 分钟后的饱腹与精力。
fn needs_after(step: f64) -> (f64, f64) {
    let mut w = common::world_with(topology(), 720.0, &[("r1", "阿树", "loc_a")]);
    w.set_need_values("r1", Some(20.0), Some(90.0)).unwrap();
    let revision = w.actor("r1").unwrap().actions.revision;
    let actions = [
        json!({"intent":{"verb":"吃饭"},"prop_id":"meal"}),
        json!({"intent":{"verb":"制作器物"},"prop_id":"bench_a"}),
    ]
    .map(|a| serde_json::from_value(a).unwrap());
    w.run_actions("r1", "meal-then-work", revision, &actions)
        .unwrap();
    advance(&mut w, 20.0, step);
    let needs = &w.actor("r1").unwrap().needs;
    (needs.fullness.value, needs.energy.value)
}

/// 推进步长不同，身体变化按活动的实际时间结算，结果相同。
#[test]
fn needs_use_the_actual_activity_time_at_any_step_size() {
    let (coarse, fine) = (needs_after(20.0), needs_after(0.1));
    assert!((coarse.0 - fine.0).abs() < 1e-8, "{coarse:?} {fine:?}");
    assert!((coarse.1 - fine.1).abs() < 1e-8, "{coarse:?} {fine:?}");
    assert!(coarse.0 > 20.0, "吃过饭饱腹回升：{coarse:?}");
}

/// 快进的空档：有人还在路上时没有；都在做有结束时间的事时，是离最近一个人做完的分钟数；
/// 空等的人按 Agent 约好的再想时间算，没约就没有空档。
#[test]
fn quiet_window_opens_only_while_everyone_is_busy_with_something_that_ends() {
    let mut w = common::world_with(
        topology(),
        720.0,
        &[("r1", "阿树", "loc_a"), ("r2", "阿禾", "loc_a")],
    );
    assert_eq!(w.quiet_minutes(|_| None), None, "刚住进来，都在等新计划");
    assert_eq!(
        w.quiet_minutes(|_| Some(45.0)),
        Some(45.0),
        "约好 45 分钟后再想"
    );
    let stay = |minutes: f64| json!({"intent":{"verb":"停留","duration_minutes":minutes}});
    common::run(&mut w, "r2", "rest", stay(60.0)).unwrap();
    common::run(
        &mut w,
        "r1",
        "walk",
        json!({"intent":{"verb":"前往","locale":"loc_b"}}),
    )
    .unwrap();
    w.step(0.5);
    assert_eq!(w.quiet_minutes(|_| Some(45.0)), None, "阿树还在路上");
    common::finish(&mut w, "r1", "walk");
    common::run(&mut w, "r1", "nap", stay(30.0)).unwrap();
    w.step(0.1);
    let left = w.quiet_minutes(|_| None).expect("两人都在待着");
    assert!((left - 29.9).abs() < 1e-6, "{left}");
}
