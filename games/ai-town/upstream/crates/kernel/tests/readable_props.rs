//! 真实动作、版本与实例；正文、客观事实和长期记忆互不混淆。
use crate::common;
use kernel::World;
use protocol::ActionStatus;
use serde_json::{json, Value};
fn world() -> World {
    let topo = common::two_places(json!([
        {"id":"board","definition":"test:bulletin_board@1","locale":"loc_a"},
        {"id":"desk","definition":"test:writing_desk@1","locale":"loc_a"},
        {"id":"book-a","definition":"test:book@1","locale":"loc_a"},
        {"id":"book-b","definition":"test:book@1","locale":"loc_a"}
    ]));
    common::world_with(
        topo,
        420.0,
        &[("a", "读者甲", "loc_a"), ("b", "读者乙", "loc_a")],
    )
}
fn run(w: &mut World, actor: &str, id: &str, draft: Value) {
    common::run(w, actor, id, draft).unwrap();
}
fn restore(w: &World) -> World {
    common::restore(w, world())
}
fn read(prop: &str) -> Value {
    json!({"prop_id":prop,"intent":{"verb":"read"}})
}
fn write() -> Value {
    json!({"prop_id":"desk","intent":{"verb":"写作"},"writing":{"title":"我的短篇","text":"只有读完的人能看到这段原创正文。"}})
}
/// 同一条公告可以几个人同时看；一本书同一时间只能一个人读。
#[test]
fn a_notice_can_be_read_together_but_a_book_cannot() {
    let mut w = world();
    w.create_content(
        "user:notice".into(),
        "loc_a".into(),
        "通知".into(),
        "管理员".into(),
        "正文".into(),
        Some("board".into()),
    )
    .unwrap();
    run(&mut w, "a", "a-notice", read("user:notice"));
    run(&mut w, "b", "b-notice", read("user:notice"));
    let together = common::finish(&mut w, "b", "b-notice");
    assert_eq!(together.status, ActionStatus::Succeeded, "{together:?}");
    let first = common::finish(&mut w, "a", "a-notice");
    assert_eq!(first.status, ActionStatus::Succeeded, "{first:?}");

    run(&mut w, "a", "a-book", read("book-a"));
    run(&mut w, "b", "b-book", read("book-a"));
    let blocked = common::finish(&mut w, "b", "b-book");
    assert_eq!(blocked.status, ActionStatus::Failed);
    assert!(
        format!("{blocked:?}").contains("正被其他村民使用"),
        "{blocked:?}"
    );
}

#[test]
fn reading_freezes_version_and_withdrawal_blocks_new_starts() {
    let mut w = world();
    w.create_content(
        "user:notice".into(),
        "loc_a".into(),
        "通知".into(),
        "管理员".into(),
        "初版正文".into(),
        Some("board".into()),
    )
    .unwrap();
    run(&mut w, "a", "old", read("user:notice"));
    w.step(5.0);
    let old = w
        .content_detail("user:notice")
        .unwrap()
        .content
        .unwrap()
        .text;
    w.revise_bulletin(
        "user:notice",
        1,
        "新通知".into(),
        "管理员".into(),
        "修订正文".into(),
    )
    .unwrap();
    w = restore(&w);
    let first = common::finish(&mut w, "a", "old");
    assert_eq!(
        w.contents()
            .reading_result("a", first.event_ids[0])
            .unwrap()
            .content
            .text,
        old
    );
    run(&mut w, "b", "new", read("user:notice"));
    let second = common::finish(&mut w, "b", "new");
    assert_eq!(
        w.contents()
            .reading_result("b", second.event_ids[0])
            .unwrap()
            .content
            .version,
        2
    );
    w.withdraw_bulletin("user:notice", 2).unwrap();
    w = restore(&w);
    assert!(common::run(&mut w, "a", "blocked", read("user:notice")).is_err());
    assert_eq!(
        w.contents()
            .reading_result("a", first.event_ids[0])
            .unwrap()
            .content
            .text,
        old
    );
    assert!(w.content_detail("user:notice").unwrap().withdrawn);
}
#[test]
fn writing_draft_restart_interrupt_and_retry_do_not_create_extra_books() {
    let mut w = world();
    let n = w.topo.props().len();
    run(&mut w, "a", "draft", write());
    w.step(50.0);
    assert_eq!(w.topo.props().len(), n);
    w = restore(&w);
    assert!(w
        .actor("a")
        .unwrap()
        .current
        .content_label()
        .unwrap()
        .contains("我的短篇"));
    w.interrupt_actions("a", "改主意");
    w.step(0.1);
    assert_eq!(w.topo.props().len(), n);
    assert_eq!(
        w.action_group("a", "draft").unwrap().results[0].status,
        ActionStatus::Interrupted
    );
    run(&mut w, "a", "finish", write());
    w.step(20.0);
    w = restore(&w);
    let r = common::finish(&mut w, "a", "finish");
    assert_eq!(r.status, ActionStatus::Succeeded);
    assert_eq!(w.topo.props().len(), n + 1);
    assert!((r.ended_at - r.started_at.unwrap() - 120.0).abs() < 1e-7);
    run(&mut w, "a", "finish", write());
    w.step(1.0);
    w = restore(&w);
    assert_eq!(w.topo.props().len(), n + 1);
    let book = w
        .topo
        .props()
        .iter()
        .find(|p| p.id.starts_with("written:"))
        .unwrap()
        .id
        .clone();
    let d = w.content_detail(&book).unwrap();
    assert_eq!(d.locale, "loc_a");
    let content = d.content.unwrap();
    assert_eq!(
        content.origin,
        kernel::content::Origin::Resident { actor: "a".into() }
    );
    assert_eq!(content.author, "读者甲");
    run(&mut w, "b", "reader", read(&book));
    let result = common::finish(&mut w, "b", "reader");
    assert_eq!(
        w.contents()
            .reading_result("b", result.event_ids[0])
            .unwrap()
            .content
            .text,
        "只有读完的人能看到这段原创正文。"
    );
}
