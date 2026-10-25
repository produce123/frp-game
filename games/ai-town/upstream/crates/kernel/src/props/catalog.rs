//! 道具库：定义按 `id@version` 索引。内容由调用方从数据文件读入，这里不内嵌任何文件。
use super::*;
use crate::error::{KernelError, Result};
use crate::topology::{Prop, PropVerb};

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub definitions: BTreeMap<String, Definition>,
}
impl Catalog {
    pub fn from_json(json: &str) -> Result<Self> {
        let definitions: Vec<Definition> = serde_json::from_str(json)
            .map_err(|e| KernelError::props(format!("道具库格式错误：{e}")))?;
        let mut result = Self::default();
        for definition in definitions {
            result.insert(definition)?;
        }
        Ok(result)
    }
    pub fn insert(&mut self, definition: Definition) -> Result<()> {
        definition.validate()?;
        let key = definition.reference();
        if let Some(old) = self.definitions.get(&key) {
            if old != &definition {
                return Err(KernelError::props(format!(
                    "道具版本 {key} 已存在且内容不同；请增加版本号"
                )));
            }
        } else {
            self.definitions.insert(key, definition);
        }
        Ok(())
    }
    pub fn resolve(&self, instance: &Instance) -> Result<Prop> {
        let definition = self
            .definitions
            .get(&instance.definition)
            .ok_or_else(|| KernelError::props(format!("缺少道具版本 {}", instance.definition)))?;
        resolve(instance, definition)
    }

    /// 存档标识使用地图实例实际引用的完整功能定义，不再还原旧版动作映射。
    pub fn world_definition(&self, topology_json: &str) -> Result<serde_json::Value> {
        let mut value: serde_json::Value =
            serde_json::from_str(topology_json).map_err(|e| KernelError::props(e.to_string()))?;
        if let Some(props) = value
            .get_mut("props")
            .and_then(serde_json::Value::as_array_mut)
        {
            for prop in props {
                if prop.get("definition").is_none() || prop.get("verbs").is_some() {
                    continue;
                }
                let instance: Instance = serde_json::from_value(prop.clone())
                    .map_err(|e| KernelError::props(e.to_string()))?;
                self.resolve(&instance)?;
                *prop = serde_json::json!({
                    "definition": self.definitions[&instance.definition],
                    "instance": instance,
                });
            }
        }
        Ok(value)
    }
}
pub fn resolve(instance: &Instance, definition: &Definition) -> Result<Prop> {
    definition.validate()?;
    if instance.definition != definition.reference()
        || instance.id.is_empty()
        || instance.id.len() > 180
        || instance.locale.is_empty()
        || instance.locale.len() > crate::ID_MAX_BYTES
        || instance
            .name
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 100)
    {
        return Err(KernelError::props("道具实例的编号、名称或版本引用无效"));
    }
    Ok(Prop {
        portable: definition.portable,
        stack_limit: definition.stack_limit,
        storage_slots: definition.storage_slots,
        id: instance.id.clone(),
        name: instance
            .name
            .clone()
            .unwrap_or_else(|| definition.name.clone()),
        description: definition.description.clone(),
        locale: instance.locale.clone(),
        definition: Some(definition.reference()),
        board: instance.board.clone(),
        readable: definition.readable.clone(),
        bulletin_board: definition.bulletin_board,
        withdrawn: false,
        verbs: definition
            .actions
            .iter()
            .map(|a| PropVerb {
                verb: a.label.clone(),
                duration_minutes: Some(a.duration_minutes),
                effects: BTreeMap::new(),
                action: Some(a.clone()),
            })
            .collect(),
    })
}
