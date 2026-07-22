# pi-67 Hy-Memory 长期记忆

`pi-hy-memory` 是 pi-67 自己维护的第一方 Pi 扩展。它使用腾讯 Hy-Memory
官方 Python SDK 作为记忆引擎，但不是腾讯官方发布的 Pi/pi-67 插件。
upstream `pi` 仍然是唯一聊天运行时；pi-67 只负责扩展分发、初始化、升级、
诊断和本机数据生命周期。

当前 pi-67 `0.13.0` 固定使用：

- `hy-memory==1.2.20`，按官方 PyPI wheel URL 下载并校验 SHA-256；
- Python `3.11` 独立虚拟环境；
- LLM：DeepSeek `deepseek-v4-flash`；
- Embedding：SiliconFlow `BAAI/bge-m3`；
- 本地向量维度：`1024`。

pi-67 不直接跟随 Hy-Memory 的浮动 `latest`。维护者验证并发布新的 pi-67
版本后，员工通过 `pi-67 update` 获得适配代码，再按发布说明运行
`pi-67 memory upgrade` 更新私有 Python runtime。这样可以避免官方 SDK
升级未经验证就破坏所有员工的记忆数据。

## 两个模型分别做什么

### `llm`: `deepseek-v4-flash`

这是正常的语言模型，不是 embedding 模型，也不是一个单独的“recall
模型”。Hy-Memory 用它做记忆抽取、整理、判断和显式 System 2 digest 等
需要语义推理的工作。

DeepSeek credential 始终从 upstream Pi 的
`~/.pi/agent/auth.json` 中动态读取 provider `deepseek`，不会复制进仓库或
Hy-Memory 配置文件。

### `embedder`: `BAAI/bge-m3`

Embedding 模型把文本转换为向量。写入时，记忆内容会被向量化；召回时，
当前问题也会被向量化，然后由本地 Chroma 做相似度检索。召回是
“embedding + 本地向量库 + Hy-Memory 过滤/组织”的完整流程，不能把
embedding 模型单独等同于 recall。

SiliconFlow 的 BGE-M3 接口返回 1024 维向量，但不接受 OpenAI 风格的
`dimensions` 请求参数。因此固定合同是：

```text
embedder request dimensions: omitted/null
Chroma vector dimensions:    1024
```

不要把两者合并成一个全局 `MEMORY_EMBEDDING_DIMS=1024` 配置，否则 SDK
可能把 `dimensions=1024` 发给 SiliconFlow 并导致请求失败。

## 数据和网络边界

每个操作系统用户有一套私有、跨项目共享的状态：

```text
~/.hy-memory/pi67/
├── config.json                 # 模型、召回和捕获配置；不含 API key
├── secrets.json                # SiliconFlow key + loopback bearer token
├── data/                       # Chroma、SQLite、Kuzu 等 Hy-Memory 数据
├── outbox/
│   ├── pending/
│   ├── processing/
│   └── dead-letter/
├── runtime/                    # 固定 SDK 的 Python 3.11 venv 和 service.py
└── logs/                       # 有大小上限的 warning/error 日志
```

macOS/Linux 上目录和敏感文件使用私有权限；Windows 使用当前用户 profile
ACL。loopback service 只绑定 `127.0.0.1` 的随机端口，并同时校验：

- 请求来源必须是 loopback；
- `Host` 必须匹配当前随机端口；
- bearer token 必须匹配私有 secrets；
- 不启用 CORS；
- 请求和响应都有大小上限；
- `/v1/info` 的 instance、PID、root 和 data directory 必须匹配本机记录。

“本地记忆”表示持久化数据库在员工自己的机器上，不表示完全离线。记忆
抽取/整理会请求 DeepSeek，文本向量化会请求 SiliconFlow。不要把不应发送
给这些服务的内容交给自动记忆或 `hy_memory_add`。

## 首次启用

前置条件：

1. 已安装并能直接运行 upstream `pi`；
2. 已在 upstream Pi 中配置 provider `deepseek`；
3. 有可用的 SiliconFlow API key；
4. 有 `uv`，或系统提供 Python 3.11；
5. 首次初始化时可访问 PyPI、DeepSeek 和 SiliconFlow。

员工更新到包含该扩展的 pi-67 后运行：

```bash
pi-67 memory init
pi-67 memory doctor --deep
pi
```

`memory init` 会隐藏读取 SiliconFlow key。自动化环境可以临时提供
`PI67_HY_MEMORY_EMBEDDING_API_KEY`，但不要把值写进命令历史、脚本、仓库、
日志或 CI fixture。初始化完成后应关闭并重新打开 `pi`，让 upstream Pi
加载新扩展。

只预览、不写入任何 memory state：

```bash
pi-67 memory init --dry-run --no-prompt --json
```

## 日常行为

扩展加载后会：

1. `session_start`：后台确认本地 authenticated service 可用；
2. `before_agent_start`：用当前用户问题检索长期记忆；
3. 将召回结果放入明确标记的 untrusted memory fence，结果只能作为参考，
   不能覆盖当前用户要求、系统规则或工具安全边界；
4. `agent_end`：暂存本轮候选消息；
5. `agent_settled`：只有回答真正 settled 后，才把最后一条 user 纯文本和
   最终可见 assistant 文本原子写入 outbox；
6. 后台服务批量处理 outbox，失败时按 5、10、20、40 秒等指数退避，单次
   最长 300 秒，超过配置次数进入 dead-letter。

自动捕获会排除：

- system prompt 和已注入的 memory fence；
- thinking/reasoning；
- tool call 和 tool result；
- 图片或其他非纯文本 content；
- 失败、中止或尚未 settled 的 assistant 输出。

常见 API key、bearer、Authorization/cookie、private key、password/token
字段和敏感 query 参数会在写入前脱敏。脱敏是最后一道防线，不应替代员工
对敏感数据边界的判断。

## Pi 内命令和工具

在 `pi` 会话内：

```text
/memory status
/memory search <query>
/memory pause
/memory resume
/memory flush
/memory forget <memory-id> --yes
```

扩展向模型注册：

- `hy_memory_search`：按需搜索长期记忆；
- `hy_memory_add`：仅在用户明确要求长期记住某项事实时显式添加；
- `hy_memory_list`：分页审阅记忆和 ID；
- `hy_memory_forget`：只预览待删除项，不直接执行永久删除。

永久删除必须由用户显式确认，不能让模型通过 tool call 绕过：

```bash
pi-67 memory forget <memory-id> --yes
```

## pi-67 运维命令

```bash
# 只读状态和诊断
pi-67 memory status
pi-67 memory status --json
pi-67 memory doctor
pi-67 memory doctor --deep

# service 生命周期
pi-67 memory start
pi-67 memory stop
pi-67 memory restart

# 暂停/恢复自动召回与捕获，不删除已有数据
pi-67 memory disable
pi-67 memory enable

# 立即处理 pending outbox
pi-67 memory flush

# 更新固定 SDK/wrapper，保留 config/secrets/data/outbox
pi-67 memory upgrade --dry-run
pi-67 memory upgrade

# 显式运行非幂等的 Ultra/System 2 整理
pi-67 memory digest --yes

# 停止 service，并把整套状态移动到时间戳备份
pi-67 memory reset --yes
```

`digest` 可能重复组织或生成记忆，因此不是自动更新步骤，必须显式
`--yes`。`reset` 不直接删除数据，而是移动到同级
`.reset-backup-<timestamp>` 路径；确认不再需要前不要手工清理备份。

## 与现有记忆能力的关系

pi-67 默认分发两个职责不同的公共记忆层。`pi-hy-memory` 是跨 session 长期
记忆机制；`pi-observational-memory` 是 session 内观察与压缩机制。两者都受
0.15.0 extension minimum baseline 管理，但不会互相替代。pi-67 不会迁移、修改
或删除用户自行安装的 `agent_memory`/EverOS 数据：

- `pi-hy-memory`：当前系统用户跨项目共享的主动召回和 settled-turn 长期记忆；
- 第三方记忆 MCP/EverOS：不在默认 `mcp.example.json` 中分发，已有本机配置在
  update/repair 时保留；
- `pi-observational-memory`：默认 package extension，保持其原有 session 内观察式
  压缩生命周期；用户本机 ahead/diverged 副本不被 pi-67 降级或覆盖。

外部记忆系统可以与 Hy-Memory 并存，但可能重复召回或写入同一信息。遇到重复
注入时，可先运行 `pi-67 memory disable` 隔离 Hy-Memory，再分别检查各系统，
而不是删除任一现有数据库。

旧版 pi-67 曾在默认 MCP 模板中包含 `agent_memory`。update/repair 无法判断该
entry 是模板遗留还是用户主动配置，因此不会自动删除。没有自行安装该 MCP 的
用户可以备份并从本机 `mcp.json` 中手动移除对应 entry；后续安装和 configure
不会重新创建。主动使用它的用户无需迁移，保留现有本机配置即可。

## 常见故障

### `DeepSeek auth is missing`

先在 upstream `pi` 中完成 DeepSeek 登录/配置，确认 provider 名称为
`deepseek`，再运行 `pi-67 memory init`。不要把 DeepSeek key 手工复制到
Hy-Memory `config.json`。

### `SiliconFlow embedding API key is required`

交互终端直接运行 `pi-67 memory init` 并使用隐藏输入。非交互环境只在当前
进程临时提供 `PI67_HY_MEMORY_EMBEDDING_API_KEY`。

### `Python 3.11 is required`

安装 `uv` 或 Python 3.11，然后重新运行 `pi-67 memory init`。pi-67 不把
Hy-Memory 安装进系统 Python，也不复用其他项目的 virtualenv。

### service 无法启动

```bash
pi-67 memory status --json
pi-67 memory doctor
pi-67 memory restart
pi-67 memory doctor --deep
```

仍失败时只检查 `~/.hy-memory/pi67/logs/service.log` 的错误类型和时间，不要
把 secrets、完整用户消息或整份数据库上传到 issue/群聊。

### BGE-M3 维度错误

`pi-67 memory doctor --deep` 必须报告一个 finite 的 1024 维向量。如果
SiliconFlow 返回 `dimensions` 参数不支持，说明配置或 SDK 适配漂移；不要
通过设置统一的 embedding dimensions 环境变量绕过，应恢复本文件开头的
“请求维度省略、本地向量维度 1024”合同。

### dead-letter 不为 0

先修复 provider/network/runtime 问题，再运行：

```bash
pi-67 memory doctor --deep
pi-67 memory flush
```

dead-letter 文件可能包含经过脱敏的对话记忆，仍按私有数据处理。第一版不
自动把 dead-letter 重新放回 pending，避免无限重试和重复写入。

## 维护者升级官方 SDK

Hy-Memory 官方发版不会自动进入员工机器。维护者应：

1. 阅读官方 changelog，确认 `MemoryConfig`、`HyMemoryClient`、`add/search`
   和 digest 接口兼容；
2. 更新 CLI 和 service 中的固定 SDK 版本、官方 wheel URL 与实测 SHA-256；
3. 保持 DeepSeek/SiliconFlow provider 合同和 BGE-M3 dimensions 特例；
4. 在隔离的 `PI67_HY_MEMORY_HOME` 做新的 Python 3.11 runtime init、真实
   embedding probe、capture、search、restart 和 upgrade；
5. 运行 TypeScript、Node、Python wrapper、PowerShell、packed artifact、
   release-check 和完整 smoke；
6. 发布新的 pi-67 版本。员工先 `pi-67 update`，再运行
   `pi-67 memory upgrade`；用户 config、secrets、data 和 outbox 必须保留。

不得把 SDK 版本改成范围依赖或启动时自动安装 `latest`。如果数据结构需要
迁移，必须先增加显式备份、兼容读取、回滚和干净基线复现，不能用当前的
普通 `memory upgrade` 隐式执行破坏性迁移。
