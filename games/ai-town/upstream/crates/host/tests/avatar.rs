use crate::support::*;
use serde_json::{json, Value};
use std::{net::TcpStream, time::Duration};
use tungstenite::WebSocket;

pub(crate) fn command(
    ws: &mut WebSocket<TcpStream>,
    state: &Value,
    sequence: u64,
    command: Value,
) -> Value {
    let id = format!("avatar-{sequence}");
    send(
        ws,
        json!({"type":"avatar","world_id":state["world_id"],"request_id":id,"epoch":state["epoch"].as_str().unwrap_or(""),"sequence":sequence,"command":command}),
    );
    until(ws, |m| {
        m["type"] == "avatar_result" && m["request_id"] == id
    })
}
pub(crate) fn state(ws: &mut WebSocket<TcpStream>) -> Value {
    let w = reply(ws, json!({"type":"get_world_settings"}), "world_settings")["state"].clone();
    command(ws, &w, 0, json!({"kind":"view"}))["state"].clone()
}

#[test]
fn authoritative_input_single_controller_save_failure_and_restart() {
    let mut town = Town::new();
    town.args = map_args(MAP_2D);
    let mut ws = town.start();
    let s = state(&mut ws);
    assert_eq!(s["supported"], true);
    assert!(
        s["client_positions"].is_null(),
        "二维地图不应接受客户端位置"
    );
    let entered = command(
        &mut ws,
        &s,
        1,
        json!({"kind":"enter","name":"aya","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    let s = entered["state"].clone();
    let history = reply(
        &mut ws,
        json!({"type":"get_chat_history","resident":"player_avatar","request_id":"avatar-history","offset":0}),
        "chat_history",
    );
    assert_eq!(history["resident"], "player_avatar");
    assert_eq!(history["total"], 0);
    let mut other = connect_again(&ws);
    let observed = state(&mut other);
    assert!(observed["resume_token"].is_null());
    assert!(
        observed["actor"].is_null(),
        "other connection received private control view: {observed}"
    );
    assert!(observed["inventory"].is_null());
    assert!(observed["interactions"].is_null());
    assert_eq!(
        command(
            &mut other,
            &observed,
            1,
            json!({"kind":"resume","token":s["resume_token"]})
        )["ok"],
        false,
        "活动租约不能被第二个连接抢走"
    );
    assert_eq!(
        command(
            &mut other,
            &observed,
            2,
            json!({"kind":"enter","name":"另一页面","appearance":{"marker":"我","color":"#387963"}})
        )["ok"],
        false
    );
    // 化身在场不再限制倍率：60 原样生效；随后换回 1 便于观察行走。
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"test-set-speed","speed":60}),
    );
    until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 60.0);
    send(
        &mut ws,
        json!({"type":"set_speed","request_id":"test-set-speed","speed":1}),
    );
    let roster = until(&mut ws, |m| m["type"] == "roster" && m["speed"] == 1.0);
    assert_eq!(members(&roster).len(), 1);
    assert_eq!(members(&roster)[0]["kind"], "avatar");
    let old = s["actor"]["locus"].clone();
    let input = json!({"type":"avatar_input","world_id":s["world_id"],"epoch":s["epoch"],"sequence":1,"navigation_revision":s["navigation_revision"],"direction":[0,-1]});
    send(&mut ws, input.clone());
    until(&mut ws, |m| {
        m["type"] == "avatar_state" && m["state"]["actor"]["locus"] != old
    });
    // 没有后续输入时自动停步；重送旧序号不能再次启动。
    std::thread::sleep(Duration::from_millis(650));
    let stopped = state(&mut ws)["actor"]["locus"].clone();
    send(&mut ws, input);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(state(&mut ws)["actor"]["locus"], stopped);
    let profile = json!({"kind":"profile","name":"aya 新名字","appearance":{"marker":"我","color":"#a15338"}});
    assert_eq!(command(&mut ws, &s, 3, profile.clone())["ok"], true);
    assert_eq!(command(&mut ws, &s, 3, profile)["ok"], true);
    assert_eq!(command(&mut ws, &s, 3, json!({"kind":"stop"}))["ok"], false);
    // 原子保存的目标被目录挡住时，化身修改回滚且全镇暂停；只操作隔离目录。
    let original = town.save().with_extension("saved");
    std::fs::rename(town.save(), &original).unwrap();
    std::fs::create_dir(town.save()).unwrap();
    let failed = command(
        &mut ws,
        &s,
        4,
        json!({"kind":"profile","name":"不应留下","appearance":{"marker":"我","color":"#387963"}}),
    );
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["state"]["actor"]["name"], "aya 新名字");
    assert_eq!(failed["state"]["speed"], 0.0);
    std::fs::remove_dir(town.save()).unwrap();
    std::fs::rename(original, town.save()).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let token = s["resume_token"].clone();
    drop(ws);
    std::thread::sleep(Duration::from_millis(200));
    let resumed = command(&mut other, &s, 5, json!({"kind":"resume","token":token}));
    assert_eq!(resumed["ok"], true, "{resumed}");
    assert_ne!(resumed["state"]["epoch"], s["epoch"]);
    let s = resumed["state"].clone();
    assert_eq!(
        command(&mut other, &s, 1, json!({"kind":"leave"}))["ok"],
        true
    );
    drop(other);
    town.shutdown();
    let mut ws = town.start();
    let s = state(&mut ws);
    assert_eq!(s["actor"]["present"], false);
    assert_eq!(s["actor"]["name"], "aya 新名字");
    assert_eq!(s["actor"]["locus"]["at"]["kind"], "offstage");
    let saved = town.saved(|v| v["schema_version"] == 5);
    assert!(saved["population"]["residents"]
        .as_object()
        .unwrap()
        .is_empty());
    let entered = command(
        &mut ws,
        &s,
        2,
        json!({"kind":"enter","name":"aya 新名字","appearance":{"marker":"我","color":"#a15338"}}),
    );
    assert_eq!(entered["ok"], true, "{entered}");
    assert_eq!(entered["state"]["actor"]["locus"], stopped);
}

/// v3 存档（人物没有 kind 字段）读入后居民的需求与位置不变，人口原样保留，原文件留有备份。
#[test]
fn legacy_save_migration_preserves_residents() {
    let mut town = Town::new();
    let mut ws = town.start();
    let resident = join_id(&mut ws, "tpl_a");
    town.shutdown();
    drop(ws);
    let mut old: Value = serde_json::from_slice(&std::fs::read(town.save()).unwrap()).unwrap();
    old["schema_version"] = json!(3);
    old["world"]["schema_version"] = json!(3);
    for a in old["world"]["actors"].as_object_mut().unwrap().values_mut() {
        a.as_object_mut().unwrap().remove("kind");
    }
    std::fs::write(town.save(), serde_json::to_vec(&old).unwrap()).unwrap();
    let before = old["world"]["actors"][&resident].clone();
    let mut ws = town.start();
    until(&mut ws, |m| m["type"] == "roster");
    town.shutdown();
    let current: Value = serde_json::from_slice(&std::fs::read(town.save()).unwrap()).unwrap();
    assert_eq!(
        current["world"]["actors"][&resident]["needs"],
        before["needs"]
    );
    assert_eq!(
        current["world"]["actors"][&resident]["locus"],
        before["locus"]
    );
    assert_eq!(current["population"], old["population"]);
    assert!(
        std::path::PathBuf::from(format!("{}.before-avatar-v1", town.save().display())).exists()
    );
}
