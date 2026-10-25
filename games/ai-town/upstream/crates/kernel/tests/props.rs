use crate::common;
use kernel::{
    props::{Definition, Instance, Placement},
    KernelError, World,
};
use serde_json::json;
fn definition() -> Definition {
    serde_json::from_value(json!({"id":"player:hammock","version":1,"name":"吊床","actions":[{
        "id":"rest","label":"躺一会","duration_minutes":10,
        "during":[{"kind":"restore_need","need":"energy","per_minute":1,"pause_decay":true}],"completion":"sleep"
    }]})).unwrap()
}
fn world() -> World {
    let mut w = common::world_with(
        common::two_places(json!([])),
        420.0,
        &[("r", "居民", "loc_a")],
    );
    w.set_need_values("r", Some(100.0), Some(20.0)).unwrap();
    w.tune_needs(
        "r",
        protocol::NeedsTuning {
            fullness_decay: 0.0,
            energy_decay: 0.0,
            ..kernel::default_tuning()
        },
    )
    .unwrap();
    w
}
fn placement(d: Definition) -> Placement {
    Placement {
        instance: Instance {
            id: "user:hammock".into(),
            definition: d.reference(),
            locale: "loc_a".into(),
            name: None,
            board: None,
        },
        definition: d,
    }
}
fn rest(w: &mut World, actor: &str, id: &str) -> Result<(), KernelError> {
    common::run(
        w,
        actor,
        id,
        json!({"prop_id":"user:hammock","intent":{"verb":"rest"}}),
    )
    .map(|_| ())
}
/// 线上协议的道具定义是内核类型的 JSON；protocol 的样本（前端类型比对用）读进内核类型再写出不变。
#[test]
fn wire_sample_definition_is_the_kernel_shape() {
    let sample: serde_json::Value = serde_json::from_str(include_str!(
        "../../protocol/tests/wire/prop-definition.json"
    ))
    .unwrap();
    let definition: Definition = serde_json::from_value(sample.clone()).unwrap();
    assert_eq!(serde_json::to_value(&definition).unwrap(), sample);
}

#[test]
fn world_definition_tracks_referenced_prop_behavior_without_scene_rules() {
    let text = common::two_places_json(|data| {
        data["props"] = json!([{"id":"bed","definition":"test:bed@1","locale":"loc_a"}]);
    });
    let current = common::catalog().world_definition(&text).unwrap();
    let mut changed = common::catalog();
    changed.definitions.get_mut("test:bed@1").unwrap().actions[0].duration_minutes = 240.0;
    assert_ne!(current, changed.world_definition(&text).unwrap());
    // 未放进地图的定义不影响这张地图的存档标识。
    let mut extended = common::catalog();
    extended.insert(definition()).unwrap();
    assert_eq!(current, extended.world_definition(&text).unwrap());
}

#[test]
fn condition_and_occupancy_are_authoritative_and_interrupt_keeps_elapsed_effects() {
    let mut w = world();
    w.spawn("other", "另一人", "loc_a").unwrap();
    w.enable_agent("other").unwrap();
    w.place_prop(placement(definition())).unwrap();
    rest(&mut w, "r", "rest").unwrap();
    w.step(2.0);
    rest(&mut w, "other", "occupied").unwrap();
    w.step(0.1);
    assert_eq!(
        w.action_group("other", "occupied").unwrap().status,
        protocol::GroupStatus::Failed
    );
    let value = w.actor("r").unwrap().needs.energy.value;
    w.interrupt_actions("r", "测试中断");
    w.step(1.0);
    assert_eq!(w.actor("r").unwrap().needs.energy.value, value);
}
