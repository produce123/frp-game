// 化身入口：观察模式底部居中的入口按钮，和进入小镇的对话框。
import type { AvatarCommand, AvatarState } from './types'
import type { LookChoice } from './looks'
import { field, keycap, markerSvg } from './view'
import { isTouch } from '../platform'
import { frpMe } from '../platformAccount'
import { button, el } from '../dom'

type Actor = NonNullable<AvatarState['actor']>

function entryPill(openDialog: () => void) {
  const pill = el('button')
  pill.type = 'button'
  pill.className = 'avatar-enter'
  // 「化身」这个词新手不认识：悬停时说清是什么
  pill.title = '用一个自己的角色进镇走走；走到村民身边就能和他们说话'
  const dot = el('i'),
    text = el('strong'),
    sub = el('small')
  dot.className = 'avatar-dot'
  pill.append(dot, text, sub)
  pill.onclick = () => openDialog()
  return { pill, dot, text, sub }
}

/** 进入对话框：实时预览、预设色（或外观）、说明出现地点与键位 */
function entryDialog(
  choice: LookChoice,
  closeDialog: () => void,
  execute: (command: AvatarCommand) => Promise<boolean>
) {
  const backdrop = el('div')
  backdrop.className = 'avatar-backdrop'
  backdrop.hidden = true
  const dialog = el('form')
  dialog.className = 'avatar-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', '进入小镇')
  const title = el('h3', '进入小镇')
  const preview = el('div'),
    previewMark = el('span')
  preview.className = 'avatar-preview'
  previewMark.className = 'avatar-preview-mark'
  if (choice.hasLooks) preview.append(el('p', '选一个样子。村民会记住这个名字，改名不换人。'))
  else
    preview.append(previewMark, el('p', '这是你在地图上的样子。村民会记住这个名字，改名不换人。'))
  preview.classList.toggle('avatar-preview-text', choice.hasLooks)
  const name = el('input')
  name.placeholder = '你的名字'
  name.maxLength = 24
  // 平台账号就是身份：默认用首页那个昵称，进来不用再想名字；仍可改（改了只影响镇里的称呼）
  name.value = frpMe()?.name?.slice(0, 24) || '旅人'
  name.required = true
  name.setAttribute('aria-label', '化身名字')
  const refreshPreview = () => {
    if (!choice.hasLooks) previewMark.replaceChildren(markerSvg(picker.value, 56))
  }
  const picker = choice.picker(choice.initial, () => refreshPreview())
  refreshPreview()
  const hint = el('p')
  hint.className = 'avatar-hint'
  const enter = el('button', '进入小镇')
  enter.type = 'submit'
  enter.className = 'avatar-primary'
  const cancel = button('取消', () => closeDialog())
  cancel.className = 'avatar-ghost'
  const actions = el('div')
  actions.className = 'avatar-dialog-actions'
  actions.append(cancel, enter)
  const nameField = field('名字', name),
    lookField = field(choice.caption, picker.root)
  const fields = choice.hasLooks ? [lookField, nameField] : [nameField, lookField]
  dialog.append(title, preview, ...fields, hint, actions)
  backdrop.append(dialog)
  dialog.onsubmit = (e) => {
    e.preventDefault()
    void execute(choice.command('enter', name.value, picker.value))
  }
  return { backdrop, title, name, picker, refreshPreview, hint, enter }
}

/** 对话框里的说明：从哪里出现、怎样走动和互动。 */
function showHint(hint: HTMLElement, returning: boolean) {
  const where = returning ? '你会回到上次离开的位置。' : '你会从小镇入口出现。'
  // 触屏没有键盘：直接点地图/人物，不再有摇杆和动作钮
  if (isTouch()) {
    hint.replaceChildren(
      where,
      ' 点地图走过去；想和人或东西互动，直接点他们。背包在右下角。'
    )
    return
  }
  hint.replaceChildren(
    where,
    ' 点地图走过去，点人或东西走过去并互动；也可以用 ',
    keycap('W'),
    keycap('A'),
    keycap('S'),
    keycap('D'),
    ' 移动，',
    keycap('E'),
    ' 和身边的东西互动，',
    keycap('B'),
    ' 打开背包。'
  )
}

export function createAvatarEntry(
  choice: LookChoice,
  handlers: {
    openDialog: () => void
    closeDialog: () => void
    execute: (command: AvatarCommand) => Promise<boolean>
  }
) {
  const pill = entryPill(handlers.openDialog)
  const dialog = entryDialog(choice, handlers.closeDialog, handlers.execute)
  const { backdrop, picker } = dialog
  // 游戏界面快捷栏上的「进入小镇」跟着入口是否可用
  let available = false
  const listeners = new Set<(available: boolean) => void>()
  return {
    pill: pill.pill,
    backdrop,
    picker,
    isOpen: () => !backdrop.hidden,
    close() {
      backdrop.hidden = true
    },
    onAvailable(listener: (available: boolean) => void) {
      listeners.add(listener)
      listener(available)
    },
    /** 打开对话框；回到小镇时填上次的名字和颜色 */
    open(actor: Actor | null | undefined) {
      if (actor) {
        dialog.name.value = actor.name
        picker.set(actor.appearance.color)
        dialog.refreshPreview()
      }
      dialog.title.textContent = actor ? '回到小镇' : '进入小镇'
      dialog.enter.textContent = actor ? '回到上次的位置' : '进入小镇'
      showHint(dialog.hint, !!actor)
      backdrop.hidden = false
      pill.pill.hidden = true
      // 触屏上聚焦会弹出键盘盖住半屏，等玩家自己点名字框
      if (!isTouch()) {
        dialog.name.focus()
        dialog.name.select()
      }
    },
    /** 入口按钮跟着控制与连接状态变；进入控制后对话框自动关掉。
     *  supported：这个世界开放了化身控制 */
    render(view: {
      supported: boolean
      controlling: boolean
      online: boolean
      occupied: boolean
      actor?: Actor | null
    }) {
      if (view.controlling && !backdrop.hidden) backdrop.hidden = true
      pill.pill.hidden = view.controlling || !backdrop.hidden
      pill.pill.disabled = !view.online || view.occupied
      pill.text.textContent = !view.online
        ? '等小镇连上…'
        : view.occupied
          ? '已有页面控制人物'
          : view.actor
            ? '继续化身'
            : '进入化身'
      pill.sub.textContent = view.actor && view.online && !view.occupied ? view.actor.name : ''
      const next = view.supported && !pill.pill.disabled
      if (next !== available) {
        available = next
        for (const listener of listeners) listener(next)
      }
      choice.paintDot(pill.dot, view.actor?.appearance.color ?? picker.value)
    },
  }
}
