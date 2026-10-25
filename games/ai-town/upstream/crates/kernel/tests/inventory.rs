use crate::common;
use kernel::{KernelError, World};
use protocol::{GroupStatus, InventoryAction as Op};
use serde_json::{json, Value};
fn world() -> World {
    common::world_with(
        common::two_places(json!([])),
        420.0,
        &[("a", "甲", "loc_a"), ("b", "乙", "loc_a")],
    )
}
fn put(w: &mut World, id: &str, mut d: Value) {
    if d.get("id").is_none() {
        d["id"] = json!("player:flower");
    }
    d["version"] = json!(1);
    if d.get("name").is_none() {
        d["name"] = json!("野花");
    }
    if d.get("actions").is_none() {
        d["actions"] = json!([]);
    }
    let def: kernel::props::Definition = serde_json::from_value(d).unwrap();
    w.place_prop(serde_json::from_value(json!({"instance":{"id":id,"definition":def.reference(),"locale":"loc_a"},"definition":def})).unwrap()).unwrap();
}
fn flower(w: &mut World, id: &str) {
    put(w, id, json!({"portable":true,"stack_limit":5}));
}
fn submit(w: &mut World, who: &str, key: &str, d: Value) -> Result<(), KernelError> {
    common::run(w, who, key, d).map(|_| ())
}
fn transfer(w: &mut World, who: &str, key: &str, op: Op) -> Result<(), KernelError> {
    submit(
        w,
        who,
        key,
        json!({"intent":{"verb":op.label()},"inventory":op}),
    )
}
fn finish(w: &mut World, who: &str, key: &str) {
    common::finish(w, who, key);
    assert_eq!(
        w.action_group(who, key).unwrap().status,
        GroupStatus::Succeeded,
        "{:?}",
        w.action_group(who, key)
    );
}
fn pick(w: &mut World, id: &str) {
    transfer(
        w,
        "a",
        &format!("pick-{id}"),
        Op::PickUp {
            items: vec![id.into()],
        },
    )
    .unwrap();
    finish(w, "a", &format!("pick-{id}"));
}
/// 物品还在地图上（没被拿走、存起或消耗）。
fn on_map(w: &World, id: &str) -> bool {
    w.prop_views().iter().any(|p| p.id == id && p.on_map)
}
fn snapshot(w: &World) -> Value {
    serde_json::to_value(w.snapshot()).unwrap()
}
fn restored(w: &World) -> World {
    common::restore(w, world())
}
fn source(w: &mut World) {
    put(
        w,
        "source",
        json!({"id":"player:supply","name":"补给箱","actions":[{"id":"eat","label":"吃干粮","duration_minutes":2,"on_complete":[{"kind":"restore","need":"fullness","amount":25}],"supply":{"initial":10,"cost":1},"portion_name":"一份干粮","recipient":true}]}),
    );
}
#[test]
fn generic_items_stack_and_transfer_identity_while_fixed_furniture_is_rejected() {
    let mut w = world();
    for i in 0..6 {
        flower(&mut w, &format!("f{i}"));
    }
    put(&mut w, "bed", json!({"id":"player:bed","name":"床"}));
    assert!(transfer(
        &mut w,
        "a",
        "bed",
        Op::PickUp {
            items: vec!["bed".into()]
        }
    )
    .is_err());
    for i in 0..6 {
        pick(&mut w, &format!("f{i}"));
    }
    assert_eq!(w.inventory_view("a").used, 2);
    assert!(!on_map(&w, "f0"));
    assert!(transfer(
        &mut w,
        "b",
        "steal",
        Op::PickUp {
            items: vec!["f0".into()]
        }
    )
    .is_err());
    submit(
        &mut w,
        "a",
        "go",
        json!({"intent":{"verb":"前往","locale":"loc_b"}}),
    )
    .unwrap();
    finish(&mut w, "a", "go");
    transfer(
        &mut w,
        "a",
        "drop",
        Op::Drop {
            items: vec!["f0".into(), "f1".into()],
        },
    )
    .unwrap();
    finish(&mut w, "a", "drop");
    assert!(on_map(&w, "f0"));
    assert_eq!(w.topo.prop("f0").unwrap().locale, "loc_b");
    let mut r = restored(&w);
    assert_eq!(snapshot(&w), snapshot(&r));
    transfer(
        &mut r,
        "a",
        "again",
        Op::PickUp {
            items: vec!["f0".into()],
        },
    )
    .unwrap();
    finish(&mut r, "a", "again");
    assert!(r.inventory().carried_by("f0", "a"));
    assert_eq!(r.topo.props().iter().filter(|p| p.id == "f0").count(), 1);
}
#[test]
fn supply_take_and_direct_use_share_stock_and_portable_effects_work_elsewhere() {
    let mut w = world();
    source(&mut w);
    let op = Op::Take {
        source: "source".into(),
        action: "eat".into(),
        quantity: 3,
    };
    transfer(&mut w, "a", "take", op).unwrap();
    w.step(0.4);
    let mut w = restored(&w);
    finish(&mut w, "a", "take");
    assert_eq!(snapshot(&w)["supplies"]["source/eat"], 7);
    let bag = w.inventory_view("a");
    assert_eq!(bag.slots[0].quantity, 3);
    let item = bag.slots[0].items[0].clone();
    submit(
        &mut w,
        "a",
        "go",
        json!({"intent":{"verb":"前往","locale":"loc_b"}}),
    )
    .unwrap();
    finish(&mut w, "a", "go");
    w.set_body_values("a", Some(30.0), None, None, None)
        .unwrap();
    submit(
        &mut w,
        "a",
        "eat",
        json!({"intent":{"verb":"eat"},"prop_id":item}),
    )
    .unwrap();
    finish(&mut w, "a", "eat");
    assert!(w.actor("a").unwrap().needs.fullness.value > 50.0);
    assert!(!w.inventory().carried_by(&item, "a"));
    assert!(!on_map(&w, &item));
    submit(
        &mut w,
        "b",
        "onsite",
        json!({"intent":{"verb":"eat"},"prop_id":"source"}),
    )
    .unwrap();
    finish(&mut w, "b", "onsite");
    assert_eq!(snapshot(&w)["supplies"]["source/eat"], 6);
    assert_eq!(w.inventory_view("a").slots[0].quantity, 2);
    assert_eq!(snapshot(&restored(&w)), snapshot(&w));
}
