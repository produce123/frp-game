use crate::common;
use kernel::{Topology, World};
use serde_json::{json, Value};
fn world() -> World {
    let mut t: Value = serde_json::from_str(include_str!("fixtures/physiology-s7.json")).unwrap();
    t["precise_navigation"] = json!(true);
    let arrival = t["places"][0]["arrival_station"]
        .as_str()
        .unwrap()
        .to_string();
    let root = "arrival_node".to_string();
    t["stations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["id"] == arrival)
        .unwrap()["node"] = json!(root);
    t["locales"].as_array_mut().unwrap().push(json!({"id":"indoor_food","name":"前往食物","kind":"transit","minutes":2,"from_node":root,"to_node":"food_node"}));
    for (side, node) in [("a", root.as_str()), ("b", "food_node")] {
        t["passages"].as_array_mut().unwrap().push(json!({"id":format!("food_{side}"),"a":"indoor_food","b":"lab_room","node_a":node,"node_b":node,"minutes":0,"capabilities":["通行"]}));
    }
    t["stations"].as_array_mut().unwrap().push(json!({"id":"use_food","locale":"lab_room","name":"食物操作点","kind":"slot","node":"food_node"}));
    let mut topo = Topology::from_json(&t.to_string(), &common::catalog()).unwrap();
    topo.prop_station_prefix = Some("use_".into());
    let mut w = common::world_with(topo, 420., &[("a", "a", "lab_room")]);
    w.set_body_values("a", Some(20.), Some(80.), Some(80.), Some(100.))
        .unwrap();
    w
}
fn eat(w: &mut World) {
    common::run(
        w,
        "a",
        "eat",
        json!({"prop_id":"food","intent":{"verb":"吃干粮"}}),
    )
    .unwrap();
}
#[test]
fn effects_wait_for_arrival_and_completion_and_restore_during_approach() {
    let mut w = world();
    eat(&mut w);
    w.step(0.1);
    assert!(matches!(
        w.actor("a").unwrap().locus.at,
        protocol::At::Transit { .. }
    ));
    assert!(w.prop_occupants("food").is_empty());
    w.step(0.9);
    assert!(w.actor("a").unwrap().needs.fullness.value < 20.);
    let mut restored = common::restore(&w, world());
    for game in [&mut w, &mut restored] {
        game.step(1.);
        assert_eq!(game.actor("a").unwrap().current.verb, "吃干粮");
        assert_eq!(
            game.actor("a").unwrap().locus.at,
            protocol::At::Station {
                station: "use_food".into()
            }
        );
        game.step(10.);
        assert!(game.actor("a").unwrap().needs.fullness.value > 30.);
    }
    assert_eq!(
        serde_json::to_value(&w.actor("a").unwrap().needs).unwrap(),
        serde_json::to_value(&restored.actor("a").unwrap().needs).unwrap()
    );
}
