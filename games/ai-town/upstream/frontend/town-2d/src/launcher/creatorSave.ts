import { errorText } from 'town-shared/format'
import type { CreatorContext } from './creatorContext'
import { setBusy } from './creatorPreview'

// 保存当前这一版草稿，默认保存完直接进镇。保存期间整张表单都不能点；保存回来时要求已经改了
// 就不再离开建镇页。

function setFormDisabled(c: CreatorContext, disabled: boolean) {
  c.el<HTMLButtonElement>('creator-back').disabled = disabled
  c.el<HTMLButtonElement>('generate-town').disabled = disabled
  for (const id of ['save-only', 'reroll-town', 'refine-town', 'reparse-town', 'draft-name'])
    c.el<HTMLButtonElement>(id).disabled = disabled
  c.el<HTMLFormElement>('creator-form')
    .querySelectorAll<HTMLInputElement>('input,select,textarea,button')
    .forEach((e) => {
      if (disabled) {
        if (e.disabled) c.disabledBeforeSave.add(e)
        e.disabled = true
      } else e.disabled = c.disabledBeforeSave.has(e)
    })
  if (!disabled) c.disabledBeforeSave.clear()
}

/** leave 回到选图页，onSaved 拿到新小镇的编号（进镇失败时带上原因）；给了 enter 就保存完直接进镇 */
export async function saveDraft(
  c: CreatorContext,
  leave: () => void,
  onSaved: (id: string, problem?: string) => void,
  enter?: (id: string) => Promise<void>
) {
  if (!c.draft || c.saving) return
  const name = c.input('draft-name').value.trim()
  if (!name) {
    c.status('先给小镇起个名字。')
    c.input('draft-name').focus()
    return
  }
  c.saving = true
  setFormDisabled(c, true)
  const current = c.draft,
    rev = c.revision
  c.el<HTMLButtonElement>('save-town').disabled = true
  c.status('正在保存小镇…')
  try {
    const result = await c.request<{ id: string }>('/save', {
      draft_id: current.id,
      expected_version: current.version,
      request_id: c.saveId,
      name,
      // 一句话规划的描述、世界观建议和适合住进来的人和小镇存在一起；逐步设置的小镇照旧用默认的世界观
      ...(c.languageMode
        ? {
            // 简介只存玩家那句话；之后「还想改什么」改出来的已经在地点名和世界观里了
            creation: {
              description: c.el<HTMLTextAreaElement>('town-description').value.trim(),
              worldview: c.worldview,
              residents: c.residents,
            },
          }
        : {}),
    })
    if (rev !== c.revision) return
    if (enter) {
      c.status('已保存，正在进入小镇…')
      try {
        await enter(result.id)
        return
      } catch (error) {
        // 进不去（比如世界没起来）：小镇已经存好，回到列表说明原因，在那里再进
        leave()
        onSaved(result.id, errorText(error))
        return
      }
    }
    leave()
    onSaved(result.id)
  } catch (error) {
    if (rev === c.revision) {
      c.status(errorText(error))
      c.el<HTMLButtonElement>('save-town').disabled = false
    }
  } finally {
    c.saving = false
    setFormDisabled(c, false)
    setBusy(c, false)
  }
}
