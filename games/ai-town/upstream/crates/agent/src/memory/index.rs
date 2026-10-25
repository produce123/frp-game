//! SQLite 是可重建的查询索引；存档中的世界事实和 MemoryStore 才是恢复依据。
use super::{MemoryRecord, MemoryStore, RecallQuery, TEXT_PREVIEW_CHARS};
use crate::{tools::limits, AgentError};
use rusqlite::{params, Connection};
use std::collections::BTreeMap;

/// 索引失败时保留是哪一步出错。
fn sql(step: &str) -> impl Fn(rusqlite::Error) -> AgentError + '_ {
    move |e| AgentError::Memory(format!("记忆索引{step}失败：{e}"))
}

pub struct MemoryIndex {
    db: Connection,
    revisions: BTreeMap<String, u64>,
}
impl MemoryIndex {
    pub fn new() -> Result<Self, AgentError> {
        let db = Connection::open_in_memory().map_err(sql("打开"))?;
        db.execute_batch("CREATE TABLE memories(
                actor TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, at REAL NOT NULL,
                text TEXT NOT NULL, protected INTEGER NOT NULL, confidence REAL NOT NULL,
                status TEXT NOT NULL, content INTEGER NOT NULL, PRIMARY KEY(actor,id));
            CREATE TABLE objects(actor TEXT NOT NULL,memory_id INTEGER NOT NULL,object TEXT NOT NULL,PRIMARY KEY(actor,memory_id,object));
            CREATE INDEX by_actor_time ON memories(actor,at);
            CREATE INDEX by_actor_kind ON memories(actor,kind);
            CREATE INDEX by_object ON objects(actor,object,memory_id);")
            .map_err(sql("建表"))?;
        Ok(Self {
            db,
            revisions: BTreeMap::new(),
        })
    }

    fn sync(&mut self, actor: &str, store: &MemoryStore) -> Result<(), AgentError> {
        let previous = self.revisions.get(actor).copied().unwrap_or(0);
        if previous == store.revision {
            return Ok(());
        }
        let tx = self.db.transaction().map_err(sql("开启事务"))?;
        for record in store.records.iter().filter(|r| r.revision > previous) {
            let kind = crate::labels::wire_name(&record.kind);
            let status = crate::labels::wire_name(&record.status);
            tx.execute(
                "INSERT OR REPLACE INTO memories VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    actor,
                    record.memory_id,
                    kind,
                    record.at,
                    record.text,
                    record.protected,
                    record.confidence,
                    status,
                    record.has_content()
                ],
            )
            .map_err(sql("写入"))?;
            tx.execute(
                "DELETE FROM objects WHERE actor=?1 AND memory_id=?2",
                params![actor, record.memory_id],
            )
            .map_err(sql("清理对象"))?;
            for object in &record.objects {
                tx.execute(
                    "INSERT OR IGNORE INTO objects VALUES (?1,?2,?3)",
                    params![actor, record.memory_id, object],
                )
                .map_err(sql("写入对象"))?;
            }
        }
        tx.commit().map_err(sql("提交"))?;
        self.revisions.insert(actor.into(), store.revision);
        Ok(())
    }

    pub fn recall(
        &mut self,
        actor: &str,
        store: &MemoryStore,
        query: &RecallQuery,
    ) -> Result<Vec<MemoryRecord>, AgentError> {
        if store.records.iter().any(|record| record.actor_id != actor) {
            return Err(AgentError::Query("不能检索其他村民的私有记忆".into()));
        }
        if query
            .since
            .into_iter()
            .chain(query.until)
            .any(|at| !at.is_finite() || at < 0.0)
            || query
                .text
                .as_ref()
                .is_some_and(|t| t.chars().count() > limits::QUERY_CHARS)
            || query
                .object
                .as_ref()
                .is_some_and(|t| t.len() > limits::RECALL_OBJECT_BYTES)
        {
            return Err(AgentError::Query("记忆查询的时间或文本超出范围".into()));
        }
        self.sync(actor, store)?;
        let kind = query.kind.map(|k| crate::labels::wire_name(&k));
        let limit = query.effective_limit();
        let mut statement = self.db.prepare("SELECT m.id FROM memories m WHERE actor=?1
            AND length(trim(text)) > 0 AND status != 'superseded' AND (?2 IS NULL OR instr(lower(text),lower(?2)) > 0)
            AND (?3 IS NULL OR kind=?3) AND (?4 IS NULL OR at>=?4) AND (?5 IS NULL OR at<=?5)
            AND (?6 IS NULL OR EXISTS(SELECT 1 FROM objects o WHERE o.actor=m.actor AND o.memory_id=m.id AND o.object=?6))
            ORDER BY protected DESC, content DESC, confidence DESC, at DESC, id DESC LIMIT ?7").map_err(sql("准备查询"))?;
        let ids = statement
            .query_map(
                params![
                    actor,
                    query.text,
                    kind,
                    query.since,
                    query.until,
                    query.object,
                    // 同一件事的多条记录只保留一条，多取几倍再去重。
                    (limit * 4) as i64
                ],
                |row| row.get::<_, u64>(0),
            )
            .map_err(sql("查询"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql("读取结果"))?;
        let mut result = Vec::new();
        for record in super::distinct_records(
            ids.iter().map(|id| &store.records[(*id - 1) as usize]),
            limit,
        ) {
            let mut record = record.clone();
            record.text = record.text.chars().take(TEXT_PREVIEW_CHARS).collect();
            result.push(record);
        }
        Ok(result)
    }
}
