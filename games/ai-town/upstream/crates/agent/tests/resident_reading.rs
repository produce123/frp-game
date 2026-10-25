use crate::support::{call_value, read_board};
use agent::{
    memory::MemoryKind,
    notebook::{apply_reflection, ReflectionBatch},
    session::Session,
};
use serde_json::json;

#[test]
fn two_readers_choose_one_note_or_no_note_and_sources_are_checked() {
    let mut w = crate::support::world();
    w.spawn("r2", "读者乙", "loc_a").unwrap();
    let body = "顺着木纹打磨。书中另一段选择不记住。";
    let mut sessions = vec![];
    for actor in ["r1", "r2"] {
        w.enable_agent(actor).unwrap();
        read_board(&mut w, actor, actor, body);
        let mut s = Session::new(1, actor, "");
        s.memory.consolidate(&w, actor);
        assert!(s
            .memory
            .records
            .iter()
            .all(|r| r.kind == MemoryKind::Episode));
        let id = w
            .actor(actor)
            .unwrap()
            .journal
            .events
            .last()
            .unwrap()
            .event_id;
        assert!(!call_value(&mut w, &mut s, "observe", json!({}))
            .unwrap()
            .to_string()
            .contains("顺着木纹"));
        assert!(
            !call_value(&mut w, &mut s, "inspect", json!({"id":"board"}))
                .unwrap()
                .to_string()
                .contains("顺着木纹")
        );
        let result = call_value(&mut w, &mut s, "read_content", json!({"event_id":id})).unwrap();
        assert_eq!(result["reading_result"]["content"]["text"], body);
        s.notebook.request = Some(ReflectionBatch {
            from: 0,
            through: id,
            day: 0,
            event_ids: vec![id],
            reason: "本人选择整理".into(),
        });
        let notes = if actor == "r1" {
            json!([{"path":"lessons/wood.md","title":"打磨","text":"这本书建议顺着木纹打磨，尚未实践。","event_ids":[id],"status":"candidate","reading_quotes":[{"event_id":id,"text":"顺着木纹打磨。"}]}])
        } else {
            json!([])
        };
        let update = json!({"through_event":id,"summary":"读完了一篇作品。","notes":notes});
        if actor == "r1" {
            let mut forged = update.clone();
            forged["notes"][0]["reading_quotes"][0]["text"] = json!("凭空捏造的原文");
            assert!(apply_reflection(&w, &mut s, serde_json::from_value(forged).unwrap()).is_err());
            assert!(s.notebook.pages.is_empty());
        }
        apply_reflection(&w, &mut s, serde_json::from_value(update).unwrap()).unwrap();
        let s: Session = serde_json::from_value(json!(s)).unwrap();
        sessions.push(s);
    }
    assert!(sessions[0].notebook.pages.contains_key("lessons/wood.md"));
    assert!(!sessions[1].notebook.pages.contains_key("lessons/wood.md"));
    assert!(!json!(sessions
        .iter()
        .map(|s| &s.notebook.pages)
        .collect::<Vec<_>>())
    .to_string()
    .contains("另一段选择不记住"));
    let id = w
        .actor("r1")
        .unwrap()
        .journal
        .events
        .last()
        .unwrap()
        .event_id;
    let mut stranger = Session::new(3, "stranger", "");
    assert!(call_value(
        &mut w,
        &mut stranger,
        "read_content",
        json!({"event_id":id})
    )
    .is_err());
}
