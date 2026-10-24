"""LLM 决策接入（联机空座补位）—— 规范协议 / 候选枚举 / prompt / 客户端 / 校验。

对齐 docs/llm-ai-design.md §2/§6/§7/§8；与前端 src/game/llm 同规格（双份翻译约定）。
仅服务端使用：环境变量配置（LLM_*），空座补位时由 LLMPlayer 装配。
"""
