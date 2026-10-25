//! 作品的世界入口：玩家侧的创建、修订与撤下，以及活动里的阅读与写作接线。
use super::*;
use crate::error::{KernelError, Result};
use crate::World;
use protocol::ContentDetail;

impl World {
    pub fn content_detail(&self, id: &str) -> Result<ContentDetail> {
        self.contents.detail(&self.topo, id)
    }

    pub fn create_content(
        &mut self,
        id: String,
        locale: String,
        title: String,
        author: String,
        text: String,
        board: Option<String>,
    ) -> Result<ContentDetail> {
        ensure!(
            id.starts_with("user:") && crate::props::identifier(&id, true),
            KernelError::content("实例编号须为有效的 user: 编号")
        );
        let content = Text {
            work_id: id.clone(),
            version: 1,
            kind: if board.is_some() {
                Kind::Bulletin
            } else {
                Kind::Book
            },
            title,
            author,
            text,
            origin: Origin::Player,
        };
        content.validate()?;
        self.place_prop(book_placement(id.clone(), locale, content, board))?;
        self.content_detail(&id)
    }

    pub fn revise_bulletin(
        &mut self,
        id: &str,
        expected_version: u32,
        title: String,
        author: String,
        text: String,
    ) -> Result<ContentDetail> {
        self.contents
            .revise_bulletin(id, expected_version, title, author, text)?;
        self.contents.restore_props(&mut self.topo)?;
        self.affordances.rebuild(&self.topo);
        self.content_detail(id)
    }

    pub fn withdraw_bulletin(&mut self, id: &str, expected_version: u32) -> Result<ContentDetail> {
        self.contents.withdraw_bulletin(id, expected_version)?;
        self.contents.restore_props(&mut self.topo)?;
        self.affordances.rebuild(&self.topo);
        self.content_detail(id)
    }

    /// 活动开始时冻结正文：阅读锁定当前版本，写作把草稿定成作品。
    pub(crate) fn prepare_content(&mut self, actor: &str) -> Result<()> {
        let pending = rules::pending_for(&self.affordances, &self.topo, &self.actors[actor])?;
        self.actor_mut(actor).current.content = pending;
        Ok(())
    }

    /// 活动完成：阅读出带正文来源的回执，写作把书放进世界。
    pub(crate) fn complete_content(
        &mut self,
        actor: &str,
    ) -> Result<Option<crate::outcome::Receipt>> {
        let Some(pending) = self.actors[actor].current.content.clone() else {
            return Ok(None);
        };
        match pending {
            Pending::Reading { prop_id, content } => Ok(Some(
                self.contents.reading_receipt(actor, &prop_id, &content),
            )),
            Pending::Writing { placement } => {
                let t = placement
                    .definition
                    .readable
                    .as_ref()
                    .ok_or_else(|| KernelError::content("写作草稿缺少作品"))?;
                let receipt = crate::outcome::Receipt {
                    text: crate::outcome::finished_writing(
                        &t.author,
                        &t.title,
                        &placement.instance.id,
                        &self.topo.locale_name(&placement.instance.locale),
                    ),
                    readable: None,
                };
                self.place_prop(*placement)?;
                Ok(Some(receipt))
            }
        }
    }

    pub(crate) fn record_completed_reading(&mut self, actor: &str, event_id: u64) {
        if let Some(pending) = self.actors[actor].current.content.clone() {
            let now = self.minutes;
            self.contents.record_reading(actor, event_id, &pending, now);
        }
    }
}
