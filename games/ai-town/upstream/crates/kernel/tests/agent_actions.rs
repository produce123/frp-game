use crate::common;
use kernel::World;
use protocol::{ActionDraft, IntentDraft};

fn world() -> World {
    // 此夹具只定义空间；测试道具的时长与效果独立于作者可编辑配置。
    let topo = common::two_places(serde_json::json!([
        {"id":"board", "name":"公告栏", "locale":"loc_a", "board":"fixture-board",
         "readable":{"work_id":"b1","version":1,"kind":"bulletin","title":"公告","author":"佚名","text":"图书馆今天开放","origin":{"kind":"builtin"}},
         "verbs":[{"verb":"阅读公告", "duration_minutes":1,"action":{"id":"read_bulletin","label":"阅读公告","duration_minutes":1,"completion":"read_bulletin"}}]},
        {"id":"wood", "name":"木料架", "locale":"loc_b", "verbs":[{"verb":"取用木料", "duration_minutes":1}]},
        {"id":"bench", "name":"木工台", "locale":"loc_b", "verbs":[{"verb":"制作器物", "duration_minutes":1}]},
        {"id":"fixture-board","name":"公告栏支架","locale":"loc_a","bulletin_board":true,"verbs":[{"verb":"查看支架","duration_minutes":1}]}
    ]));
    common::world_with(topo, 420.0, &[("r1", "阿树", "loc_a")])
}

fn action(verb: &str, prop: Option<&str>) -> ActionDraft {
    ActionDraft {
        inventory: None,
        recipient: None,
        writing: None,
        intent: IntentDraft {
            verb: verb.into(),
            locale: None,
            target: None,
            duration_minutes: None,
            until: None,
        },
        prop_id: prop.map(Into::into),
    }
}
fn go(locale: &str) -> ActionDraft {
    let mut a = action("前往", None);
    a.intent.locale = Some(locale.into());
    a
}

#[test]
fn whole_group_validation_does_not_install_a_valid_prefix() {
    let mut w = world();
    let revision = w.actor("r1").unwrap().actions.revision;
    let before = serde_json::to_value(w.snapshot()).unwrap();
    let bad = [action("阅读公告", Some("board")), action("编造能力", None)];
    assert!(w.run_actions("r1", "bad", revision, &bad).is_err());
    assert_eq!(before, serde_json::to_value(w.snapshot()).unwrap());
    assert!(w
        .run_actions("r1", "stale", revision - 1, &[go("loc_b")])
        .is_err());
    let mut too_short = action("阅读公告", Some("board"));
    too_short.intent.duration_minutes = Some(0.1);
    assert!(w
        .run_actions("r1", "short", revision, &[too_short])
        .is_err());
}
