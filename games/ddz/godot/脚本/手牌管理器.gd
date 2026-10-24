extends Control

# 在线牌桌 —— 把平台的服务器权威视图画成上游那张牌桌。
#
# 【和上游 手牌管理器.gd 的关系】
#   视觉部分（手牌沿曲线排列、选牌散开、牌面贴图、语音播报、地主帽子、结算界面）
#   全是上游的；**牌局本身一行都不在这里**：发牌、叫地主、抢地主、谁能出、出得对不对、
#   谁赢了，统统由服务器（`games/ddz/js/engine/**`）算，这里只做两件事：
#     1. 收到视图 → 画出来；
#     2. 玩家点了按钮 → 通过 JS 桥把意图发回去。
#
# 【为什么不用 WebSocketPeer】
#   平台那一套联机（登录、房间、邀请、重连、心跳）已经写在 `shared/net/net.js` +
#   `shared/ui/room.js` 里，而且有测试。这里再写一份 GDScript 的 WS 客户端，
#   等于把同一套协议实现两遍。所以壳页面（`/ddz/`）负责联机，牌桌只跟页面上的
#   两个对象打交道：
#     window.FrpDdzTable.推视图(json)     ← 壳页面把裁剪过的视图塞进来
#     window.FrpDdzHost.动作(json)        ← 牌桌把玩家意图发出去
#     window.FrpDdzHost.事件(名字)        ← 就绪 / 再来一次 / 退出
#
# 【没有倒计时、没有电脑】与平台口径一致（D40，取代 D35）：三个真人，谁离开这局就作废。
# 上游那三个时钟倒计时节点在这里**一直隐藏**（服务器没有超时托管，画个倒计时就是骗人）。

const 花色名: Array[String] = ["黑桃", "红桃", "梅花", "方片"]
const 点数名 := {
	3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
	11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王",
}

# 有"点数语音"的牌型（上游 牌型播报 里的 有点数牌型）：语音文件名带点数，例如 顺子_3_10.mp3
const 有点数牌型: Array[String] = ["单张", "对子", "三张", "三带一", "三带二", "炸弹", "顺子"]

@onready var 音效播放器: AudioStreamPlayer = $"音效播放器"
@onready var 背景播放器: AudioStreamPlayer = $"背景播放器"
@onready var 人声播报播放器: AudioStreamPlayer = $"人声播报播放器"
@onready var 提示播报播放器: AudioStreamPlayer = $"提示播报播放器"

@onready var 中心点: Control = $"中心点"
@onready var 手牌线点 = $"手牌排列线/手牌线/手牌线点"
@onready var 打出牌堆 = $"打出牌堆"
@onready var 底牌展示 = $"底牌展示"
@onready var 打出按钮 = $"玩家按钮/打出按钮"
@onready var 不要按钮 = $"玩家按钮/不要按钮"
@onready var 结算界面 = $"结算界面"
@onready var 地主帽子 = $"地主帽子"
@onready var 玩家文字显示 = $"玩家文字显示"
@onready var 上家文字显示 = $"上家文字显示"
@onready var 下家文字显示 = $"下家文字显示"
@onready var 玩家牌数显示 = $"玩家牌数显示"
@onready var 上家牌数显示 = $"上家牌数显示"
@onready var 下家牌数显示 = $"下家牌数显示"
@onready var 牌堆牌数显示 = $"牌堆牌数显示"

@export var 选择上升曲线: Curve
@export var 选择分散曲线: Curve
@export_range(0, 100) var 选择上升距离: float
@export_range(0, 100) var 选择分散距离: float
@export var 扑克牌: PackedScene

# 手牌列表（玩家自己的）
var 玩家手牌列表: Array[Node] = []
var 玩家选择列表: Array[Node] = []
var 操作禁止 := true

# 视图缓存
var 视图: Dictionary = {}
var 我的座位 := 0
var 手牌指纹 := ""
var 打出指纹 := ""
var 底牌指纹 := ""
var 上次播报 := ""
var 上次文字: Array[String] = ["", "", ""]
var 上次张数: Array[int] = [-1, -1, -1]
var 已结算 := false
var 已发牌 := false

# 名字与头像（运行时建，不改进上游场景文件）
var 名称标签: Array[Label] = []
var 头像节点: Array[TextureRect] = []
var 提示标签: Label

# JS 桥的回调必须留引用，否则被回收
var _桥_推视图: JavaScriptObject
var _桥_重置: JavaScriptObject
var 已连桥 := false
var 桥重试 := 0


func _ready():
	# 上游那三个倒计时在这个版本里没有意义（服务器不管超时），一律不显示
	$"玩家时钟倒计时".visible = false
	$"上家时钟倒计时".visible = false
	$"下家时钟倒计时".visible = false
	# 没有牌堆（牌是服务器发的，不在本地摸）
	牌堆牌数显示.visible = false
	地主帽子.visible = false
	打出按钮.visible = false
	不要按钮.visible = false
	结算界面.visible = false
	结算界面.再来一次.connect(_再来一次)
	结算界面.退出游戏.connect(_退出游戏)
	打出按钮.button_down.connect(_打出按钮按下)
	不要按钮.button_down.connect(_不要按钮按下)
	建玩家信息()
	建提示标签()
	连接JS桥()


# ============================== JS 桥 ==============================

func 连接JS桥():
	if not OS.has_feature("web"):
		return
	# 牌桌跑在 iframe 里，桥是**父页面**挂到本窗口上的。两边谁先到都有可能
	# （Godot 的 wasm 起来了、父页面那边可能还在等 load 事件），所以这里轮询等一等。
	var 表 = JavaScriptBridge.get_interface("FrpDdzTable")
	if 表 == null:
		桥重试 += 1
		if 桥重试 <= 100:
			await get_tree().create_timer(0.1).timeout
			连接JS桥()
		else:
			push_warning("页面里没有 FrpDdzTable（不是从 /ddz/ 打开的？）")
		return
	桥重试 = 0
	_桥_推视图 = JavaScriptBridge.create_callback(_收到视图)
	_桥_重置 = JavaScriptBridge.create_callback(_收到重置)
	# ⚠️ 为什么是 `表.接上(...)` 而不是 `表.set("推视图", …)`：
	#    `JavaScriptObject` 只转发**方法调用**（`对象.方法名(...)` → `obj[方法名](...)`），
	#    没有属性赋值那条路（`set`/`call` 会被当成 JS 上真叫 set/call 的方法，报
	#    "obj[method] is not a function"）。所以由页面提供一个 `接上` 方法把回调存起来，
	#    页面自己要推视图时调 `FrpDdzTable.推视图(json)`，由它转发给这里。
	表.接上(_桥_推视图, _桥_重置)
	已连桥 = true
	发事件("就绪")


func 发事件(名字: String):
	if not OS.has_feature("web"):
		return
	var 主 = JavaScriptBridge.get_interface("FrpDdzHost")
	if 主 == null:
		return
	主.事件(名字)


func 发动作(动作: Dictionary):
	if not OS.has_feature("web"):
		return
	var 主 = JavaScriptBridge.get_interface("FrpDdzHost")
	if 主 == null:
		return
	主.动作(JSON.stringify(动作))


func _收到视图(参数: Array):
	var 文本 := ""
	if 参数.size() > 0:
		文本 = str(参数[0])
	if 文本 == "":
		return
	var 数据 = JSON.parse_string(文本)
	if typeof(数据) != TYPE_DICTIONARY:
		return
	应用视图(数据)


func _收到重置(_参数: Array):
	清桌()
	已结算 = false
	操作禁止 = true
	提示标签.text = ""


# ============================== 画牌桌 ==============================

func 应用视图(数据: Dictionary):
	视图 = 数据
	我的座位 = int(数据.get("seat", 0))
	更新玩家信息(数据)

	# ---- 手牌 ----
	var 手 = 数据.get("hand", [])
	if typeof(手) != TYPE_ARRAY:
		手 = []
	var 手牌串 := 拼指纹(手)
	if 手牌串 != 手牌指纹:
		手牌指纹 = 手牌串
		重建手牌(手)
	else:
		# 手牌没变（只是别人动了一下）也要保证位置是对的
		重置位置(计算位置(玩家手牌列表.size()))

	# ---- 三家的张数 ----
	var 玩家表 = 数据.get("players", [])
	for 一个 in 玩家表:
		var 座位 := int(一个.get("seat", 0))
		var 张数 := int(一个.get("count", 0))
		var 相对 := 相对座位(座位)
		match 相对:
			1: 下家牌数显示.更新牌数(张数)
			2: 上家牌数显示.更新牌数(张数)
			0: 玩家牌数显示.更新牌数(张数)
		if 座位 >= 0 and 座位 < 3:
			var 旧 := 上次张数[座位]
			if 旧 >= 0 and 张数 != 旧 and (张数 == 1 or 张数 == 2):
				播报提示(张数)
		上次张数[座位] = 张数

	# ---- 底牌 ----
	var 底 = 数据.get("bottom", null)
	if 底 == null or typeof(底) != TYPE_ARRAY:
		底 = []
	var 底串 := 拼指纹(底)
	if 底串 != 底牌指纹:
		底牌指纹 = 底串
		重建静态牌(底牌展示, 底)

	# ---- 上一手打出的牌 ----
	var 上一手 = 数据.get("lastPlay", null)
	if 上一手 == null or typeof(上一手) != TYPE_DICTIONARY:
		上一手 = null
	var 打出串 := ""
	if 上一手 != null:
		打出串 = str(上一手.get("seat", -1)) + "|" + 拼指纹(上一手.get("cards", []))
	if 打出串 != 打出指纹:
		打出指纹 = 打出串
		if 上一手 == null:
			清空节点(打出牌堆)
		else:
			重建静态牌(打出牌堆, 上一手.get("cards", []))
			音效播放器.stream = load("res://音频/啪音效.mp3")
			音效播放器.play()
			牌型播报(上一手)
			震场音效(str(上一手.get("type", "")))

	# ---- 三家头上的字（叫地主/不叫/抢地主/不抢/不要）----
	for 一个 in 玩家表:
		var 座位 := int(一个.get("seat", 0))
		if 座位 < 0 or 座位 >= 3:
			continue
		var 文字 := str(一个.get("label", ""))
		if 文字 != 上次文字[座位]:
			if 文字 == "不要":
				人声播报播放器.stream = load("res://音频/不要.mp3")
				人声播报播放器.play()
			上次文字[座位] = 文字
		更新文字显示(座位, 文字)

	# ---- 地主帽子 ----
	var 地主 = 数据.get("landlord", null)
	if 地主 == null:
		地主帽子.visible = false
	else:
		地主帽子.visible = true
		地主帽子.position = 帽子位置(int(地主))

	# ---- 按钮 ----
	更新按钮(数据, 上一手)

	# ---- 结算 ----
	更新结算(数据)
	发渲染()


func 更新按钮(数据: Dictionary, 上一手):
	var 阶段 := str(数据.get("phase", ""))
	var 小阶段 := str(数据.get("stage", ""))
	var 轮到 := int(数据.get("turn", -1))
	var 我该动 := 阶段 != "over" and 轮到 == 我的座位

	if not 我该动:
		打出按钮.visible = false
		不要按钮.visible = false
		操作禁止 = true
		return

	打出按钮.visible = true
	不要按钮.visible = true
	操作禁止 = false
	if 阶段 == "bidding":
		if 小阶段 == "rob":
			打出按钮.text = "抢地主"
			不要按钮.text = "不抢"
		else:
			打出按钮.text = "叫地主"
			不要按钮.text = "不叫"
		不要按钮.disabled = false
	else:
		打出按钮.text = "出牌"
		不要按钮.text = "不要"
		# 这一轮是自己领出：不能"不要"
		不要按钮.disabled = 上一手 == null


func 更新结算(数据: Dictionary):
	var 阶段 := str(数据.get("phase", ""))
	if 阶段 != "over":
		if 已结算:
			已结算 = false
			结算界面.visible = false
			提示标签.text = ""
		return

	if 已结算:
		return
	已结算 = true
	操作禁止 = true
	打出按钮.visible = false
	不要按钮.visible = false

	var 作废 = 数据.get("aborted", null)
	if 作废 != null and str(作废) != "":
		提示标签.text = "本局作废：" + str(作废)
		return

	var 赢家 = 数据.get("winner", null)
	if 赢家 == null or typeof(赢家) != TYPE_DICTIONARY:
		return
	var 赢家座位 = 赢家.get("seats", [])
	var 我赢了 := false
	for 座位 in 赢家座位:
		if int(座位) == 我的座位:
			我赢了 = true
	if 我赢了:
		结算界面.胜利()
		背景播放器.stream = load("res://音频/胜利.mp3")
	else:
		结算界面.失败()
		背景播放器.stream = load("res://音频/失败.mp3")
	背景播放器.play()


func 更新文字显示(座位: int, 文字: String):
	match 相对座位(座位):
		0: 玩家文字显示.text = 文字
		1: 下家文字显示.text = 文字
		2: 上家文字显示.text = 文字


func 相对座位(座位: int) -> int:
	# 0 = 我，1 = 下家（下一个出牌的），2 = 上家
	return (座位 - 我的座位 + 3) % 3


# ============================== 观测口 ==============================

# 每次画完把"画成什么样了"报给页面。
#
# 为什么要有这个：牌桌是一整块 canvas，**从 DOM 上什么都看不出来** ——
# 手牌几张、现在是不是结算了、按钮上写的是「叫地主」还是「出牌」。
# 所以这里把关键数字报上去，页面存进 `window.__FrpDdzTable`。
# 它只用于观察（真浏览器测试靠它断言），**页面逻辑一个字节都不读它**。
func 发渲染():
	if not 已连桥:
		return
	var 主 = JavaScriptBridge.get_interface("FrpDdzHost")
	if 主 == null:
		return
	var 上一手 = 视图.get("lastPlay", null)
	var 上一手类型 := ""
	if typeof(上一手) == TYPE_DICTIONARY:
		上一手类型 = str(上一手.get("type", ""))
	主.渲染(JSON.stringify({
		"phase": str(视图.get("phase", "")),
		"stage": str(视图.get("stage", "")),
		"seat": 我的座位,
		"turn": int(视图.get("turn", -1)),
		"hand": 玩家手牌列表.size(),
		"bottom": 底牌展示.get_child_count(),
		"played": 打出牌堆.get_child_count(),
		"lastType": 上一手类型,
		"over": 已结算,
		"names": [名称标签[0].text, 名称标签[1].text, 名称标签[2].text],
		"playButton": 打出按钮.visible,
		"passButton": 不要按钮.visible,
		"playText": 打出按钮.text,
		"passText": 不要按钮.text,
		# 两个按钮在 1280×720 画面里的位置（x, y, 宽, 高）。
		# canvas 里没有 DOM，测试要点到真按钮只能靠这四个数换算成页面坐标。
		"playButtonRect": _控件矩形(打出按钮),
		"passButtonRect": _控件矩形(不要按钮),
	}))


func _控件矩形(控件: Control) -> Array:
	var 矩形 := 控件.get_global_rect()
	return [int(矩形.position.x), int(矩形.position.y), int(矩形.size.x), int(矩形.size.y)]


# ============================== 名字 / 头像 ==============================

func 建玩家信息():
	var 字体: Font = load("res://字体/尔雅新大黑_爱给网_aigei_com.ttf")
	# 三个位置：我（左下）、下家（右中）、上家（左上）—— 挨着上游的 文字显示 放
	var 位置 := [
		Vector2(120, 366),   # 我
		Vector2(668, 236),   # 下家
		Vector2(198, 236),   # 上家
	]
	var 名字偏移 := Vector2(56, 12)
	for i in range(3):
		var 头像 := TextureRect.new()
		头像.size = Vector2(48, 48)
		头像.position = 位置[i]
		头像.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		头像.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		头像.visible = false
		add_child(头像)
		头像节点.append(头像)

		var 标签 := Label.new()
		标签.position = 位置[i] + 名字偏移
		标签.size = Vector2(150, 28)
		标签.add_theme_font_override("font", 字体)
		标签.add_theme_font_size_override("font_size", 20)
		标签.add_theme_color_override("font_color", Color(1, 1, 1, 1))
		标签.add_theme_color_override("font_outline_color", Color(0, 0, 0, 1))
		标签.add_theme_constant_override("outline_size", 6)
		标签.visible = false
		add_child(标签)
		名称标签.append(标签)


func 建提示标签():
	var 字体: Font = load("res://字体/尔雅新大黑_爱给网_aigei_com.ttf")
	提示标签 = Label.new()
	提示标签.position = Vector2(360, 96)
	提示标签.size = Vector2(560, 40)
	提示标签.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	提示标签.add_theme_font_override("font", 字体)
	提示标签.add_theme_font_size_override("font_size", 26)
	提示标签.add_theme_color_override("font_color", Color(1, 0.95, 0.6, 1))
	提示标签.add_theme_color_override("font_outline_color", Color(0, 0, 0, 1))
	提示标签.add_theme_constant_override("outline_size", 8)
	提示标签.text = ""
	add_child(提示标签)


func 更新玩家信息(数据: Dictionary):
	var 玩家表 = 数据.get("players", [])
	var 地主 = 数据.get("landlord", null)
	for 一个 in 玩家表:
		if typeof(一个) != TYPE_DICTIONARY:
			continue
		var 相对 := 相对座位(int(一个.get("seat", 0)))
		if 相对 < 0 or 相对 > 2:
			continue
		# 名字每次都重算（地主会变），别在旧文字后面往上叠
		var 文字 := str(一个.get("name", ""))
		if 地主 != null and int(一个.get("seat", -1)) == int(地主):
			文字 += "（地主）"
		名称标签[相对].text = 文字
		名称标签[相对].visible = true
		var 头像数据 = 一个.get("avatarData", null)
		if 头像数据 != null and str(头像数据) != "":
			var 图 = 解码头像(str(头像数据))
			if 图 != null:
				头像节点[相对].texture = 图
				头像节点[相对].visible = true


func 解码头像(数据串: String) -> ImageTexture:
	var 逗号 := 数据串.find(",")
	if 逗号 < 0:
		return null
	var 纯数据 := 数据串.substr(逗号 + 1)
	var 字节 := Marshalls.base64_to_raw(纯数据)
	if 字节.size() == 0:
		return null
	var 图 := Image.new()
	if 图.load_png_from_buffer(字节) != OK:
		return null
	return ImageTexture.create_from_image(图)


func 帽子位置(座位: int) -> Vector2:
	var 底 := 名称标签[相对座位(座位)].position
	return Vector2(底.x - 6, 底.y - 52)


# ============================== 手牌 ==============================

func 拼指纹(牌表) -> String:
	var 片段: Array[String] = []
	for 一张 in 牌表:
		if typeof(一张) == TYPE_DICTIONARY:
			片段.append(str(一张.get("id", "")))
	return ",".join(片段)


func 牌面数据(一张: Dictionary) -> 扑克牌类:
	var 点数 := int(一张.get("r", 3))
	var 花色序号 := int(一张.get("s", 0))
	var 花色 := ""
	if 点数 >= 16:
		花色 = ""
	elif 花色序号 >= 0 and 花色序号 < 花色名.size():
		花色 = 花色名[花色序号]
	return 扑克牌类.new(花色, str(点数名.get(点数, "3")))


func 重建手牌(牌表):
	清空手牌节点()
	for 一张 in 牌表:
		玩家手牌列表.append(新建牌节点(一张, true))
	重置位置(计算位置(玩家手牌列表.size()))
	手牌显示排序()
	玩家牌数显示.更新牌数(玩家手牌列表.size())


func 清空手牌节点():
	for 牌 in 玩家手牌列表:
		牌.queue_free()
	玩家手牌列表.clear()
	玩家选择列表.clear()


func 新建牌节点(一张, 可选: bool) -> Node:
	var 牌 = 扑克牌.instantiate()
	add_child(牌)
	var 数据 := 牌面数据(一张)
	牌.更新牌(数据)
	牌.set_meta("id", str(一张.get("id", "")))
	牌.position = 中心点.position
	牌.rotation_degrees = 0
	if 可选:
		牌.connect("鼠标进入", 鼠标进入手牌)
		牌.connect("鼠标离开", 鼠标离开手牌)
	return 牌


func 重建静态牌(容器: Node, 牌表):
	清空节点(容器)
	for 一张 in 牌表:
		if typeof(一张) != TYPE_DICTIONARY:
			continue
		var 牌 = 扑克牌.instantiate()
		容器.add_child(牌)
		牌.更新牌(牌面数据(一张))
		# HBoxContainer 里由容器排版，不要上游那套绝对定位
		牌.position = Vector2.ZERO


func 清空节点(容器: Node):
	for 子 in 容器.get_children():
		子.queue_free()


# ============================== 位置计算（上游原样） ==============================

func 重置位置(位置列表: Array[Vector2]):
	if 位置列表.size() != 玩家手牌列表.size():
		printerr("位置列表和手牌列表数量不对等!")
		return
	for i in range(0, 玩家手牌列表.size()):
		玩家手牌列表[i].移动到(位置列表[i])
		玩家手牌列表[i].旋转到(0)


func 选牌位置计算(选牌: Node) -> Array[Vector2]:
	var 手牌数量 := 玩家手牌列表.size()
	var 选牌编号 := 玩家手牌列表.find(选牌)
	var 计算后位置: Array[Vector2] = 计算位置(手牌数量)
	if 选牌编号 < 0:
		return 计算后位置
	var 左右最大牌数 := float(max(选牌编号, 手牌数量 - 选牌编号 - 1))
	var 曲线段长: float = 1.0 / (左右最大牌数 * 2.0)
	for 距中段数 in range(1, 左右最大牌数 + 1):
		if 选牌编号 - 距中段数 >= 0:
			手牌线点.progress_ratio = 1.0 / (手牌数量 + 1) * (选牌编号 - 距中段数 + 1)
			手牌线点.progress -= 选择分散距离 * 选择分散曲线.sample(曲线段长 * 距中段数)
			计算后位置[选牌编号 - 距中段数] = 手牌线点位置()
		if 选牌编号 + 距中段数 <= 手牌数量 - 1:
			手牌线点.progress_ratio = 1.0 / (手牌数量 + 1) * (选牌编号 + 距中段数 + 1)
			手牌线点.progress += 选择分散距离 * 选择分散曲线.sample(曲线段长 * 距中段数)
			计算后位置[选牌编号 + 距中段数] = 手牌线点位置()
	return 计算后位置


func 手牌显示排序():
	var 层数 := 0
	for 手牌 in 玩家手牌列表:
		手牌.z_index = 层数
		层数 += 1


func 计算位置(手牌数量: int) -> Array[Vector2]:
	var 位置列表: Array[Vector2] = []
	var 分段长: float = 1.0 / (手牌数量 + 1)
	for i in range(1, 手牌数量 + 1):
		手牌线点.progress_ratio = 分段长 * i
		位置列表.append(手牌线点位置())
	return 位置列表


func 手牌线点位置() -> Vector2:
	return 手牌线点.position + 手牌线点.get_parent().position + 手牌线点.get_parent().get_parent().position


# ============================== 输入 ==============================

var 当前选择牌: Node


func _input(event: InputEvent):
	点击牌(event)


func 鼠标进入手牌(对象: Panel):
	当前选择牌 = 对象
	重置位置(选牌位置计算(对象))


func 鼠标离开手牌(_对象: Panel):
	当前选择牌 = null
	重置位置(计算位置(玩家手牌列表.size()))


func 点击牌(event):
	if (event is InputEventMouseButton) and not 操作禁止:
		if event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
			if 当前选择牌 != null:
				当前选择牌.选中()
				if 当前选择牌.是否被选中:
					玩家选择列表.append(当前选择牌)
				else:
					玩家选择列表.erase(当前选择牌)
				重置位置(选牌位置计算(当前选择牌) if 当前选择牌.是否被选中 else 计算位置(玩家手牌列表.size()))


func _打出按钮按下():
	if 操作禁止:
		return
	var 阶段 := str(视图.get("phase", ""))
	if 阶段 == "bidding":
		发动作({"type": "bid", "value": 1})
		操作禁止 = true
		打出按钮.visible = false
		不要按钮.visible = false
		return
	if 玩家选择列表.size() == 0:
		提示标签.text = "先选牌"
		return
	var 编号: Array[String] = []
	for 牌 in 玩家选择列表:
		编号.append(str(牌.get_meta("id", "")))
	提示标签.text = ""
	发动作({"type": "play", "cards": 编号})
	操作禁止 = true
	打出按钮.visible = false
	不要按钮.visible = false


func _不要按钮按下():
	if 操作禁止:
		return
	var 阶段 := str(视图.get("phase", ""))
	if 阶段 == "bidding":
		发动作({"type": "bid", "value": 0})
	else:
		发动作({"type": "pass"})
	提示标签.text = ""
	玩家选择列表.clear()
	操作禁止 = true
	打出按钮.visible = false
	不要按钮.visible = false


# ============================== 声音 ==============================

# 上游的"炸弹换 BGM"：出炸弹/王炸时把背景音乐换成 bgm2，平时是 bgm1
func 震场音效(类型: String):
	if 类型 == "炸弹" or 类型 == "王炸":
		if 背景播放器.stream == null or 背景播放器.stream.resource_path != "res://音频/bgm2.mp3":
			背景播放器.stream = load("res://音频/bgm2.mp3")
			背景播放器.play()


# 回到房间：把牌桌清干净（壳页面在退出本局 / 换一局时调用）
func 清桌():
	清空手牌节点()
	清空节点(打出牌堆)
	清空节点(底牌展示)
	手牌指纹 = ""
	打出指纹 = ""
	底牌指纹 = ""
	上次播报 = ""
	上次文字 = ["", "", ""]
	上次张数 = [-1, -1, -1]
	玩家文字显示.text = ""
	上家文字显示.text = ""
	下家文字显示.text = ""
	玩家牌数显示.更新牌数(0)
	上家牌数显示.更新牌数(0)
	下家牌数显示.更新牌数(0)
	地主帽子.visible = false
	打出按钮.visible = false
	不要按钮.visible = false
	结算界面.visible = false
	背景播放器.stream = load("res://音频/bgm1.mp3")
	if not 背景播放器.playing:
		背景播放器.play()


func 播报提示(张数: int):
	if 张数 == 1:
		提示播报播放器.stream = load("res://音频/我就一张牌啦.mp3")
	else:
		提示播报播放器.stream = load("res://音频/我就两张牌啦.mp3")
	提示播报播放器.play()


func 牌型播报(上一手: Dictionary):
	var 类型 := str(上一手.get("type", ""))
	if 类型 == "" or 类型 == "无牌型":
		return
	var 头 := str(上一手.get("rankText", ""))
	var 尾 := str(上一手.get("tailText", ""))
	var 路径 := ""
	if 类型 in 有点数牌型:
		var 尾巴 := ""
		if 尾 != "" and 尾 != 头:
			尾巴 = "_" + 尾
		路径 = "res://音频/牌型语音/%s/%s_%s%s.mp3" % [类型, 类型, 头, 尾巴]
	else:
		路径 = "res://音频/牌型语音/%s.mp3" % 类型
	if not ResourceLoader.exists(路径):
		return
	人声播报播放器.stream = load(路径)
	人声播报播放器.play()


# ============================== 结算界面按钮 ==============================

func _再来一次():
	结算界面.visible = false
	已结算 = false
	提示标签.text = ""
	发事件("再来一次")


func _退出游戏():
	发事件("退出")