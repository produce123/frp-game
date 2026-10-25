use crate::{
    avatar::{command, state},
    support::*,
};
use serde_json::json;
use std::time::Duration;

#[test]
fn possession_lease_actions_rollback_reconnect_and_restart_use_the_original_resident() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    let resident = join_id(&mut ws, "tpl_b");
    let s = state(&mut ws);
    let entered = command(
        &mut ws,
        &s,
        1,
        json!({"kind":"possess","resident":resident}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let mut s = entered["state"].clone();
    assert_eq!(s["mode"], "possession");
    assert_eq!(s["actor"]["id"], resident);
    assert_eq!(s["actor"]["needs"].as_array().unwrap().len(), 4);
    let mut other = connect_again(&ws);
    let other_state = state(&mut other);
    assert!(other_state["resume_token"].is_null());
    assert!(other_state["recent"].is_null());
    assert_eq!(
        command(
            &mut other,
            &other_state,
            1,
            json!({"kind":"possess","resident":resident})
        )["ok"],
        false
    );
    assert_eq!(
        command(
            &mut ws,
            &s,
            2,
            json!({"kind":"profile","name":"changed","appearance":{"marker":"我","color":"#387963"}})
        )["ok"],
        false
    );
    // 先记录一个未完成的真实玩家动作，再测试交还保存失败与重启。
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"test-set-speed","speed":0.125}),
    );
    until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 0.125);
    let action = command(
        &mut ws,
        &s,
        3,
        json!({"kind":"action","revision":s["actor"]["revision"],"action":{"intent":{"verb":"停留","duration_minutes":2}}}),
    );
    assert_eq!(action["ok"], true, "{action}");
    s = action["state"].clone();
    let original = town.save().with_extension("backup");
    std::fs::rename(town.save(), &original).unwrap();
    std::fs::create_dir(town.save()).unwrap();
    let failed = command(&mut ws, &s, 4, json!({"kind":"leave"}));
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["state"]["controlled"], true);
    assert_eq!(failed["state"]["actor"]["id"], resident);
    std::fs::remove_dir(town.save()).unwrap();
    std::fs::rename(original, town.save()).unwrap();
    until(&mut ws, |m| m["type"] == "roster");
    let token = s["resume_token"].clone();
    drop(ws);
    std::thread::sleep(Duration::from_millis(150));
    let resumed = command(
        &mut other,
        &other_state,
        5,
        json!({"kind":"resume","token":token}),
    );
    assert_eq!(resumed["ok"], true, "{resumed}");
    assert_ne!(resumed["state"]["epoch"], s["epoch"]);
    assert_eq!(resumed["state"]["actor"]["id"], resident);
    let saved_text = std::fs::read_to_string(town.save()).unwrap();
    assert!(
        !saved_text.contains(token.as_str().unwrap()),
        "恢复令牌不能写入存档"
    );
    assert!(!saved_text.contains(resumed["state"]["resume_token"].as_str().unwrap()));
    town.shutdown();
    let mut ws = town.start();
    let current = state(&mut ws);
    assert_eq!(current["controlled"], false);
    let reentered = command(
        &mut ws,
        &current,
        1,
        json!({"kind":"possess","resident":resident}),
    );
    assert_eq!(reentered["ok"], true, "{reentered}");
    let s = reentered["state"].clone();
    assert_eq!(s["actor"]["id"], resident);
    assert_eq!(command(&mut ws, &s, 1, json!({"kind":"leave"}))["ok"], true);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(town.save()).unwrap()).unwrap();
    assert!(saved.to_string().contains("player_groups"));
    town.shutdown();
}

#[test]
fn resident_release_does_not_write_receipts_into_offstage_avatar() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    let resident = join_id(&mut ws, "tpl_b");
    let initial = state(&mut ws);
    let entered = command(
        &mut ws,
        &initial,
        1,
        json!({"kind":"enter","name":"aya","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true);
    let avatar = entered["state"].clone();
    assert_eq!(
        command(&mut ws, &avatar, 20, json!({"kind":"stop"}))["ok"],
        true
    );
    assert_eq!(
        command(&mut ws, &avatar, 21, json!({"kind":"leave"}))["ok"],
        true
    );
    let before =
        town.saved(|v| v["world"]["actors"]["player_avatar"]["locus"]["at"]["kind"] == "offstage");
    let observing = state(&mut ws);
    let possessed = command(
        &mut ws,
        &observing,
        1,
        json!({"kind":"possess","resident":resident}),
    );
    assert_eq!(possessed["ok"], true);
    assert_eq!(
        command(&mut ws, &possessed["state"], 2, json!({"kind":"leave"}))["ok"],
        true
    );
    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(town.save()).unwrap()).unwrap();
    assert_eq!(
        after["world"]["actors"]["player_avatar"]["avatar"],
        before["world"]["actors"]["player_avatar"]["avatar"],
        "resident release must not lower the other actor's receipt sequence"
    );
    town.shutdown();
    let mut ws = town.start();
    assert_eq!(state(&mut ws)["controlled"], false);
    town.shutdown();
}
