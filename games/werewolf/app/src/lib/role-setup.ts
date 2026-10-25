/*
 * 建房时的角色配置（只在这个文件里放"默认值"和中文名）。
 *
 * 真正的校验在服务器（`games/werewolf/engine/index.mjs` 的 `validateRoleSetup`）：
 * 总数必须等于座位数、至少 1 个狼阵营角色、屠边局必须同时有平民和神职；
 * 这里只是提前把同样的规则显示给房主，避免点了「开房」才被服务器拒绝。
 */

/** 胜利条件：屠边（默认，经典）/ 屠城。和引擎的 WIN_MODE_* 一一对应。 */
export type WinMode = "side" | "wipe";

export const WIN_MODE_OPTIONS: { key: WinMode; label: string; hint: string }[] = [
  {
    key: "side",
    label: "屠边（经典）",
    hint: "狼人杀光所有平民、或杀光所有神职，就算狼人赢",
  },
  {
    key: "wipe",
    label: "屠城",
    hint: "狼人必须把所有好人全部杀光才算赢，局会更长",
  },
];

export const SETUP_ROLES = [
  { key: "Werewolf", label: "狼人", wolf: true, hint: "每只狼各投一票，按多数刀人" },
  { key: "WhiteWolfKing", label: "白狼王", wolf: true, hint: "白天可自爆，带走一个人" },
  { key: "EvilKnight", label: "恶夜骑士", wolf: true, hint: "免疫夜刀和毒；首次被验/毒会反伤，次日带走对方" },
  { key: "WolfKing", label: "狼王", wolf: true, hint: "可自刀、可自爆；出局可开枪（被毒/自爆/最后一狼除外）" },
  { key: "WolfBeauty", label: "狼美人", wolf: true, hint: "每晚额外魅惑一人，被放逐时对方殉情" },
  { key: "Seer", label: "预言家", wolf: false, hint: "每晚查验一个人" },
  { key: "Witch", label: "女巫", wolf: false, hint: "解药、毒药各一瓶" },
  { key: "Hunter", label: "猎人", wolf: false, hint: "死时可开枪，被毒死除外" },
  { key: "Guard", label: "守卫", wolf: false, hint: "每晚守一个人，不能连守" },
  { key: "Idiot", label: "白痴", wolf: false, hint: "被投出可翻牌免死一次" },
  { key: "Knight", label: "骑士", wolf: false, hint: "白天可翻牌决斗一次：狼死并天黑，好人则自己出局" },
  { key: "Elder", label: "长老", wolf: false, hint: "夜里要挨两刀才死；被好人害死会封印所有好人神职" },
  { key: "Gravekeeper", label: "守墓人", wolf: false, hint: "每晚得知昨天公投放逐的人是好人还是狼" },
  { key: "Villager", label: "平民", wolf: false, hint: "没有技能，靠发言和投票" },
] as const;

export type SetupRole = (typeof SETUP_ROLES)[number]["key"];
export type RoleCounts = Record<SetupRole, number>;

/** 和引擎里的 `ROLE_CONFIG` 保持一致；只是建房时的默认值。 */
const DEFAULTS: Record<number, string[]> = {
  4: ["Werewolf", "Seer", "Witch", "Villager"],
  5: ["Werewolf", "Werewolf", "Seer", "Witch", "Villager"],
  6: ["Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Villager"],
  7: ["Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Villager", "Villager"],
  8: ["Werewolf", "Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Villager", "Villager"],
  9: ["Werewolf", "Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Villager", "Villager", "Villager"],
  10: ["Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Villager", "Villager", "Villager"],
  11: ["Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager"],
  12: ["Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager"],
  13: ["Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager", "Villager"],
  14: ["Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager", "Villager", "Villager"],
  15: ["Werewolf", "Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager", "Villager", "Villager"],
  16: ["Werewolf", "Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager", "Villager", "Villager", "Villager"],
  17: ["Werewolf", "Werewolf", "Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager", "Villager", "Villager", "Villager"],
  18: ["Werewolf", "Werewolf", "Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot", "Villager", "Villager", "Villager", "Villager", "Villager", "Villager", "Villager"],
};

export function emptyCounts(): RoleCounts {
  return SETUP_ROLES.reduce((out, role) => {
    out[role.key] = 0;
    return out;
  }, {} as RoleCounts);
}

export function defaultCounts(seats: number): RoleCounts {
  const counts = emptyCounts();
  for (const role of DEFAULTS[seats] || DEFAULTS[8]) {
    if (role in counts) counts[role as SetupRole] += 1;
  }
  return counts;
}

export function totalCount(counts: RoleCounts): number {
  return SETUP_ROLES.reduce((sum, role) => sum + counts[role.key], 0);
}

export function wolfCount(counts: RoleCounts): number {
  return counts.Werewolf + counts.WhiteWolfKing + counts.EvilKnight + counts.WolfKing + counts.WolfBeauty;
}

/** 神职 = 所有"不是狼、也不是平民"的角色（和引擎的 `isGoodGod` 一致）。 */
export function godCount(counts: RoleCounts): number {
  return SETUP_ROLES.filter((role) => !role.wolf && role.key !== "Villager").reduce(
    (sum, role) => sum + counts[role.key],
    0,
  );
}

/** 返回给房主看的错误；空字符串 = 可以开房。 */
export function checkCounts(seats: number, counts: RoleCounts, winMode: WinMode = "side"): string {
  const total = totalCount(counts);
  if (total !== seats) {
    return total < seats ? `还差 ${seats - total} 个角色` : `多出 ${total - seats} 个角色`;
  }
  if (wolfCount(counts) < 1) return "至少要放 1 个狼阵营角色（狼人/白狼王/狼王/狼美人/恶夜骑士）";
  if (winMode === "side" && (counts.Villager < 1 || godCount(counts) < 1)) {
    return `屠边局要同时有平民和神职（现在：平民 ${counts.Villager} 个、神职 ${godCount(counts)} 个）`;
  }
  return "";
}

export function roleLabel(key: string): string {
  return SETUP_ROLES.find((role) => role.key === key)?.label || key;
}