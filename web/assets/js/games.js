/*
 * 平台首页的游戏清单 —— **唯一需要经常改的地方**。
 *
 * 字段：
 *   title        必填  卡片标题
 *   letter       必填  标题首字的拼音首字母（A–Z），首页按它分组排序
 *   desc         必填  一句话介绍，**不超过 35 个字**（`tests/browser.smoke.mjs` 钉着）
 *   icon         可选  一个 emoji
 *   tags         可选  标签数组，搜索时会一起匹配
 *   minPlayers / maxPlayers  支持的人数范围（筛选用，会显示成「2–4 人」）
 *   slug         平台游戏必填：`server/games/<slug>.mjs` 的文件名
 *   href         外部/上游页面必填：卡片点「开始游戏」时新窗口打开的地址
 *
 * ⛔ slug 与 href 二选一：slug 会走平台房间层，href 是已经缝好的页面地址。
 * 平台游戏一定会显示；href 游戏不检查服务器是否接上（部署时缺哪个就 404）。
 */
window.GAMES = [
  {
    slug: "cannon-goblin",
    title: "大炮轰小鬼",
    letter: "D",
    desc: "不对称棋盘：大炮隔空吃子，小鬼靠数量堵死大炮。",
    icon: "💥",
    tags: ["棋盘", "策略"],
    minPlayers: 1,
    maxPlayers: 2,
  },
  {
    slug: "shell-gambit",
    title: "Shell Gambit",
    letter: "S",
    desc: "恶魔轮盘：霰弹枪、7 种道具，胆子和运气。",
    icon: "💀",
    tags: ["多人联机", "派对"],
    minPlayers: 1,
    maxPlayers: 4,
  },
  {
    slug: "blade-steed",
    title: "刀马 BladeSteed",
    letter: "D",
    desc: "武侠猜拳：赢了才能动手，买刀买马、出城砍人。",
    icon: "⚔️",
    tags: ["多人联机", "猜拳"],
    minPlayers: 1,
    maxPlayers: 4,
  },
  {
    // 无名杀：上游原版静态托管（/noname/），账号/好友/邀请走平台。
    title: "无名杀（三国杀）",
    letter: "W",
    href: "/play/noname",
    desc: "三国杀身份局 / 国战 / 塔防，完整武将包，可联机。",
    icon: "🎴",
    tags: ["三国杀", "卡牌", "身份局", "可联机"],
    minPlayers: 2,
    maxPlayers: 10,
  },
  {
    // 狼人杀：界面来自 wolfcha-custom，规则是本仓库重写的（无 AI）。
    title: "狼人杀",
    letter: "L",
    href: "/werewolf/",
    desc: "4–18 人身份局，房主配角色，打字发言，可复盘。",
    icon: "🐺",
    tags: ["身份局", "卡牌", "可联机"],
    minPlayers: 4,
    maxPlayers: 18,
  },
  {
    // 斗地主：牌桌是上游 Godot 网页导出，规则在服务器；页面在 /ddz/。
    slug: "ddz",
    title: "斗地主",
    letter: "D",
    href: "/play/ddz",
    desc: "三人一桌：叫地主、抢地主、出牌，牌桌是上游界面。",
    icon: "🃏",
    tags: ["卡牌", "可联机", "三人"],
    minPlayers: 3,
    maxPlayers: 3,
  },
  {
    // 大富翁：整份上游 Web 客户端 + 本进程 WS 中转（/monopoly-relay）。
    slug: "monopoly",
    title: "大富翁",
    letter: "D",
    href: "/play/monopoly",
    desc: "3D 棋盘：买地盖楼收租，5 张官方地图，可联机。",
    icon: "🎩",
    tags: ["棋盘", "3D", "可联机"],
    minPlayers: 1,
    maxPlayers: 6,
  },
  {
    // 莲花广麻：上游 Vue3 页面 + Python/FastAPI 规则后端，Node 只反代。
    slug: "mahjong",
    title: "莲花广麻",
    letter: "L",
    href: "/play/mahjong",
    desc: "四人广东麻将：碰杠吃胡买马，单机也能和 AI 打。",
    icon: "🀄",
    tags: ["麻将", "3D", "可联机", "四人"],
    minPlayers: 2,
    maxPlayers: 4,
  },
];