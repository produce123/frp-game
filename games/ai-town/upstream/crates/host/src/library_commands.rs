//! 村民库命令：浏览与筛选模板、查看与保存模板、归档、预览人设，以及用模型按一句话描述生成模板字段。
use crate::{
    network::{send_to, Clients},
    runtime::{Outcome, Runtime},
};
use host::{
    library::{self, render_persona},
    HostError,
};
use protocol::{
    LibraryFilter, LibraryKind, ResidentTemplate, ServerMsg, TemplateCard, TemplateFields,
    TemplateStatus,
};

impl Runtime {
    pub(crate) fn library_msg(&self, filter: &LibraryFilter) -> ServerMsg {
        let query = filter.query.trim().to_lowercase();
        let templates = self
            .library
            .all()
            .filter(|t| match filter.kind {
                LibraryKind::Builtin => t.builtin,
                LibraryKind::Custom => !t.builtin,
                LibraryKind::All => true,
            })
            .filter(|t| filter.include_archived || !t.archived)
            .filter(|t| {
                query.is_empty()
                    || t.fields.name.to_lowercase().contains(&query)
                    || t.fields.intro.to_lowercase().contains(&query)
                    || t.fields
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&query))
            })
            .map(|t| {
                let joined = self.population.joined_from(&t.template_id);
                TemplateCard {
                    template_id: t.template_id.clone(),
                    version: t.version,
                    builtin: t.builtin,
                    archived: t.archived,
                    name: t.fields.name.clone(),
                    intro: t.fields.intro.clone(),
                    tags: t.fields.tags.clone(),
                    appearance: t.fields.appearance.clone(),
                    status: if t.archived {
                        TemplateStatus::Archived
                    } else if joined.is_some() {
                        TemplateStatus::Joined
                    } else {
                        TemplateStatus::Available
                    },
                    resident_id: joined.map(|r| r.id.clone()),
                }
            })
            .collect();
        ServerMsg::ResidentLibrary {
            templates,
            custom_root: self.library.root_display(),
        }
    }

    pub(crate) fn template_msg(&self, template_id: &str) -> ServerMsg {
        match self.library.get(template_id) {
            Some(t) => ServerMsg::ResidentTemplate {
                template: Some(t.clone()),
                persona: render_persona(&t.fields),
                error: None,
            },
            None => ServerMsg::ResidentTemplate {
                template: None,
                persona: String::new(),
                error: Some("模板不存在".into()),
            },
        }
    }

    pub(crate) fn save_template(
        &mut self,
        request_id: String,
        template_id: Option<String>,
        expected_version: Option<u64>,
        fields: TemplateFields,
    ) -> Outcome {
        let result = self
            .library
            .save(template_id.as_deref(), expected_version, fields);
        Outcome::reply(template_saved(request_id, result, "模板已保存"))
    }

    pub(crate) fn archive_template(
        &mut self,
        request_id: String,
        template_id: &str,
        expected_version: u64,
        archived: bool,
    ) -> Outcome {
        let result = self
            .library
            .archive(template_id, expected_version, archived);
        Outcome::reply(template_saved(
            request_id,
            result,
            if archived {
                "已收起，镇上的村民不受影响"
            } else {
                "已放回列表"
            },
        ))
    }

    pub(crate) fn template_persona(&self, fields: &TemplateFields) -> Outcome {
        Outcome::reply(ServerMsg::TemplatePersona {
            persona: render_persona(fields),
            error: library::validate_fields(fields)
                .err()
                .map(|e| e.to_string()),
        })
    }

    /// 一句话描述 → 模型一次调用 → 字段。只填表单不保存；固定回复模式下离线整理，不连模型。
    /// 模型的回答到了只发给发出请求的连接。
    pub(crate) fn generate_template(
        &self,
        request_id: String,
        brief: String,
        connection: u64,
        clients: &Clients,
    ) -> Outcome {
        let brief = brief.trim().to_string();
        if brief.is_empty() {
            let error = HostError::Rejected("先写一句话描述这个人物".into());
            return Outcome::reply(generated(request_id, Err(error)));
        }
        if brief.chars().count() > 300 {
            let error = HostError::Rejected("描述不超过 300 字".into());
            return Outcome::reply(generated(request_id, Err(error)));
        }
        let taken: Vec<String> = self
            .library
            .all()
            .map(|t| t.fields.name.trim().to_string())
            .chain(self.population.residents.values().map(|r| r.name.clone()))
            .collect();
        if self.driver.mock {
            let result = library::mock_generated(&brief, &taken);
            return Outcome::reply(generated(request_id, result));
        }
        if self.settings.providers.active.is_none() {
            let error = HostError::Config("先在设定中心配置小镇工具模型，再用模型生成人物".into());
            return Outcome::reply(generated(request_id, Err(error)));
        }
        let target = self.driver.target.clone();
        let places: Vec<String> = self
            .world
            .topo
            .places
            .iter()
            .map(|p| p.name.clone())
            .collect();
        let prompt = agent::completion::template_prompt(&brief, &taken, &places);
        let clients = clients.clone();
        let id = request_id.clone();
        let submitted = self.tasks.submit(move || {
            let result = host::llm::chat_completion(&target, &prompt)
                .and_then(|text| agent::completion::parse_template(&text))
                .map_err(HostError::from)
                .and_then(library::tidy_generated);
            send_to(&clients, connection, &generated(id, result));
        });
        match submitted {
            Ok(()) => Outcome::none(),
            Err(error) => Outcome::reply(generated(request_id, Err(error))),
        }
    }
}

fn generated(request_id: String, result: Result<TemplateFields, HostError>) -> ServerMsg {
    match result {
        Ok(fields) => ServerMsg::TemplateGenerated {
            request_id,
            ok: true,
            message: "已按描述生成，检查后保存".into(),
            fields: Some(Box::new(fields)),
        },
        Err(error) => ServerMsg::TemplateGenerated {
            request_id,
            ok: false,
            message: error.to_string(),
            fields: None,
        },
    }
}

fn template_saved(
    request_id: String,
    result: Result<ResidentTemplate, HostError>,
    success: &str,
) -> ServerMsg {
    match result {
        Ok(template) => ServerMsg::TemplateSaved {
            request_id,
            ok: true,
            message: success.into(),
            template: Some(template),
        },
        Err(error) => ServerMsg::TemplateSaved {
            request_id,
            ok: false,
            message: error.to_string(),
            template: None,
        },
    }
}
