use crate::support::*;
use agent::{budget::Limits, runtime::ResidentRuntime};
use kernel::avatar::{Area, Spot, Surface, WalkMap};
use serde_json::json;

#[test]
fn player_handover_rejects_old_replies_keeps_facts_and_resumes_without_invented_ai_choices() {
    let mut w = world();
    let p = Spot {
        locale: "loc_a".into(),
        space: "a".into(),
        position: [2., 2.],
    };
    w.walk_map = Some(std::sync::Arc::new(WalkMap {
        version: 1,
        metres_per_minute: 12.,
        surfaces: vec![Surface {
            locale: "loc_a".into(),
            space: "a".into(),
            area: Area::Rect {
                min: [0., 0.],
                max: [10., 10.],
            },
        }],
        stations: [("st_a".into(), p.clone())].into(),
        props: [("board".into(), p)].into(),
        ..Default::default()
    }));
    let mut r = runtime(&mut w, Limits::default());
    let old = request(&mut r, &mut w);
    let instructions = r.session("r1").unwrap().instructions.clone();
    w.possess("r1").unwrap();
    r.player_handover(&mut w, "r1").unwrap();
    assert!(!reply_with(
        &mut r,
        &mut w,
        &old,
        "不应出现的旧想法",
        vec![tool_call("old", "set_goal", json!({"title":"旧目标"}))]
    ));
    assert!(r.poll(&mut w, true).is_empty());
    let rev = w.actor("r1").unwrap().actions.revision;
    w.avatar_action(
        "control/reading",
        rev,
        &serde_json::from_value(json!({"intent":{"verb":"阅读公告"},"prop_id":"board"})).unwrap(),
    )
    .unwrap();
    w.step(0.2);
    w.release_possession();
    r.player_handover(&mut w, "r1").unwrap();
    assert!(r.poll(&mut w, true).is_empty(), "交还保留玩家已开始的阅读");
    let state = r.state().clone();
    let mut r = ResidentRuntime::restore(state, &w).unwrap();
    w.step(1.);
    let next = request(&mut r, &mut w);
    let text = serde_json::to_string(&next.messages).unwrap();
    assert!(text.contains("公告"));
    assert!(
        !text.contains("附身") && !text.contains("玩家接管") && !text.contains("不应出现的旧想法")
    );
    assert_eq!(r.session("r1").unwrap().instructions, instructions);
    assert_eq!(r.state().lifetime.calls, 2);
}
