extends Control

@onready var 左彩带  = $"左彩带"
@onready var 右彩带  = $"右彩带"
@onready var 胜负图片 = $"胜负图片"
@onready var 动画播放器 = $"动画播放器"

@export var 胜利图片: Texture
@export var 失败图片: Texture

signal 再来一次
signal 退出游戏

func _ready():
    visible = false

func 失败():
    visible = true
    左彩带.visible = false
    右彩带.visible = false
    胜负图片.texture = 失败图片
    动画播放器.play("出场动画")

func 胜利():
    visible = true
    左彩带.visible = true
    右彩带.visible = true
    胜负图片.texture = 胜利图片
    动画播放器.play("出场动画")

func 再来一次按钮按下():
    再来一次.emit()

# ⚠️ 上游这里写的是 change_scene_to_file("res://场景/开始页面.tscn")。
# 这一版的"首页"是平台（`/ddz/` 的房间外壳），项目里**没有开始页面**了 ——
# 真按上游那样切场景会直接黑屏，所以改成只发信号，由壳页面决定去哪。
func 退出游戏按钮按下():
    退出游戏.emit()