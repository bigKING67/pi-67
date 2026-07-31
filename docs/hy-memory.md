# pi-67 Hy-Memory 长期记忆

`pi-hy-memory` 是 pi-67 自己维护的第一方 Pi 扩展。它使用腾讯 Hy-Memory
官方 Python SDK 作为记忆引擎，但不是腾讯官方发布的 Pi/pi-67 插件。
upstream `pi` 仍然是唯一聊天运行时；pi-67 只负责扩展分发、初始化、升级、
诊断和本机数据生命周期。

本仓库当前 Hy-Memory 发行合同固定使用：

- `hy-memory==1.2.20`，顶层 wheel 和全部 transitive distributions 都由目标平台
  lock 的精确版本与 SHA-256 约束；
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
├── operations/                  # mutation 状态 ledger；不保存 query/messages/记忆正文
├── runtime/                    # current.json + 一代或多代固定 SDK/Python runtime
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

### 原文副本和保留边界

pi-67 wrapper 在导入 SDK 前关闭当前集成不使用的 coding memory、memory
operations、history audit、pipeline DB trace 和旧 request tracer，并把 SDK 数据根
固定到本机私有 `data/`。其中 history 是可选审计能力，Pi 没有调用它的读取 API；
关闭后可避免每次 capture 再复制一份完整正文。已有 `history.db`、DB trace 和旧
trace 文件不会因此自动删除。

固定 SDK `1.2.20` 仍会在每次 capture/search 的 pipeline step 中追加 JSONL，路径为
`data/logs/pipeline/<subdir>/<date>.log`。该日志可能包含真实 query、LLM prompt/
response、解析结果和被召回记忆的预览；它与
`MEMORY_PIPELINE_TRACE_ENABLED=false` 控制的 SQLite trace 是两套独立存储。SDK
当前没有关闭 JSONL、配置保留天数或按 memory ID purge 的公共 API，因此 pi-67
不使用 monkey patch、不可写目录或第三方私有 SQL 假装解决这个边界。

`reset` 生成的同级备份也会完整保留原状态。

当前没有基于 SDK 公共 API、可验证地清理上述所有副本的单条 purge 操作。
pi-67 不直接修改第三方 SQLite 私有表，也不会在升级时自动删除既有 history、
JSONL、trace 或 reset backup。需要严格抹除时，应先停止 service、备份并按整套
状态生命周期处理，不能把 `memory forget` 当作合规意义上的全副本擦除。

`/memory status` 和 `pi-67 memory status --json` 的 service 信息会返回
`storagePolicy`，用于核对当前 live wrapper 实际启用的 history/coding/trace 状态，
并明确标记 `pipelineJsonlEnabled: true`、`fullPurgeSupported: false`。该字段是运行态
能力证明，不表示既有 retained copies 已被扫描或删除。

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
   连续失败会给出一次不含 prompt/provider response 的分类 warning，两次失败后
   进入 30 秒 session-local cooldown，避免每轮重复等待；冷却后自动探测，成功
   即重置失败计数；
3. 将召回结果放入明确标记的 untrusted memory fence，结果只能作为参考，
   不能覆盖当前用户要求、系统规则或工具安全边界；
4. `agent_end`：暂存本轮候选消息；
5. `agent_settled`：只有回答真正 settled 后，才把最后一条 user 纯文本和
   最终可见 assistant 文本原子写入 outbox；
6. 后台服务批量处理 outbox，失败时按 5、10、20、40 秒等指数退避，单次
   最长 300 秒，超过配置次数进入 dead-letter。

### Mutation identity 和终态

`capture`、`forget`、`digest` 不是普通的“HTTP 超时后重试”操作。service 为它们
写入 `operations/<operationId>.json`，状态只有：

```text
QUEUED -> RUNNING -> SUCCEEDED
                    -> UNKNOWN
QUEUED -> FAILED (retryable=true only before SDK action starts)
```

- `FAILED + retryable=true` 表示 durable evidence 已证明 SDK action 尚未开始；
- `RUNNING` 表示 SDK 已开始但 caller 的等待 deadline 已到，只能查询
  `/v1/operations/<operationId>`；
- `UNKNOWN` 表示 SDK 已开始但没有 durable terminal proof，可能已经产生副作用，
  **不得盲目重试**；
- service 重启时，旧 `QUEUED` 安全转为 retryable `FAILED`，旧 `RUNNING` 保守转为
  `UNKNOWN`；
- outbox 遇到 `RUNNING` 会留在 processing 等待终态，遇到 `UNKNOWN` 会标记
  `resolutionRequired=true` 并停止自动 retry；此时 `memory flush` 立即返回失败，
  不会把 unresolved job 当成功或等待到长 timeout。

operation ledger 最多保留 1000 条，`SUCCEEDED/FAILED` 默认保留 30 天且仍被
outbox 引用时不清理；`UNKNOWN` 不自动删除。ledger 只保存 operation kind、时间、
状态和 bounded result summary，不保存 query、messages、memory content、provider
payload、credential 或 raw exception。

自动捕获会排除：

- system prompt 和已注入的 memory fence；
- thinking/reasoning；
- tool call 和 tool result；
- 图片或其他非纯文本 content；
- 失败、中止或尚未 settled 的 assistant 输出。

常见 API key、bearer、Authorization/cookie、private key、password/token
字段和敏感 query 参数会在 capture 和 search 的 loopback service 边界脱敏；search
脱敏发生在 embedding provider 请求和 SDK pipeline log 之前。脱敏是最后一道防线，
不应替代员工对敏感数据边界的判断。

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
- `hy_memory_forget`：只预览待删除的 active memory，不直接执行删除。

删除 active memory 必须由用户显式确认，不能让模型通过 tool call 绕过：

```bash
pi-67 memory forget <memory-id> --yes
```

成功响应会保留 SDK 原字段，并明确返回：

- `activeDeleted`：active vector/graph memory 是否实际删除；
- `purgeComplete: false`：本操作不承诺历史和调试副本已擦除；
- `retainedCopies`：可能仍存在的 `history`、`pipeline-trace`、`pipeline-log` 和
  `reset-backups` 类别。该字段是能力边界说明，不表示运行时逐项扫描过这些存储。

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

# 更新固定 SDK/wrapper/Python closure，保留 config/secrets/data/outbox/operations
pi-67 memory upgrade --dry-run
pi-67 memory upgrade

# 只读盘点 runtime generations
pi-67 memory runtime inventory
pi-67 memory runtime inventory --json

# 只生成旧代候选计划；当前版本没有删除实现
pi-67 memory runtime prune --dry-run
pi-67 memory runtime prune --dry-run --json

# 显式运行非幂等的 Ultra/System 2 整理
pi-67 memory digest --yes

# 停止 service，并把整套状态移动到时间戳备份
pi-67 memory reset --yes
```

`digest` 可能重复组织或生成记忆，因此不是自动更新步骤，必须显式
`--yes`。`reset` 不直接删除数据，而是移动到同级
`.reset-backup-<timestamp>` 路径；确认不再需要前不要手工清理备份。

每次 wrapper 源码或目标平台 Python lock 变化时，`memory upgrade` 会先在旧 service
仍运行时 stage 并验证新的完整 runtime generation，再获取共享 `start.lock`，保存
`runtime/current.json` 的精确 bytes/hash，按需停止旧 service，原子切换 selection，
启动并验证目标 generation。当前版本有意不自动删除旧代，
因为它们仍可能是回滚基线或被 live PID 使用；代价是磁盘占用会随升级累积。

如果 activation、target spawn 或 readiness 失败，upgrade 会先停止本次明确创建的
target PID，再恢复原 selection；upgrade 前 service 正在运行时还会重启并验证 prior
service。失败使用 `pi67.memory-upgrade/v1` receipt 同时记录 primary phase 和 rollback
结果，`--json` 只输出一份 JSON 并以 exit code 1 退出。不能证明 target 已停止或
selection 已恢复时，receipt 会显式标记 partial rollback，不会假报成功。

`--force` 也不会原地覆盖 live generation，而是创建独立 installation identity。新受管
generation 名称绑定 wrapper 和 dependency lock：

```text
hy-memory-1.2.20-pi67-<wrapper12>-pydeps-<lock12>
hy-memory-1.2.20-pi67-<wrapper12>-pydeps-<lock12>-<installation12>  # --force
```

`runtime inventory` 只识别名称符合受管合同的 generation，统计显式维护命令的
磁盘占用，并保护 `current` 和按目录更新时间选出的最新一代 `previous`。current
metadata 指向受管 root 外、目录解析逃逸或当前代缺失时，候选选择会 fail closed。
service 仍在运行时所有 generation 都标记为受保护。

`runtime prune --dry-run` 返回 `wouldKeep`、`wouldDelete`、可回收字节、readiness
checks 和内容绑定的 `planId`。plan identity 包含 canonical runtime root identity、
service topology、current Python 路径状态，以及全部受管 generation（含
current/previous/candidate）的名称、保护原因、wrapper SHA-256 和扫描字节数；
同一快照可复现，generation 内容、候选选择或 live
service 状态变化后必须重新生成。current `service.py` 的完整 SHA-256 与目录 hash
前缀不一致、Python 缺失、size scan 不完整、没有可用 previous 或 service 仍运行时
都会 fail closed。

runtime reuse、`status`、CLI `start` 和 Pi extension 的直接启动路径共用同一组
activation invariants：`service.py` 必须是受管 generation 内的 regular non-symlink
文件，SDK/wheel identity 必须固定，Python 必须是同代 venv 的规范路径。新安装使用
`pi67-hy-memory-runtime/v2`，写入完整 `wrapperSha256`、lock ID/target/hash 和
`python-runtime.json` 的 SHA-256；manifest 记录 Python/platform、installer、全部
installed distributions 和 closure hash，activation 会复核 manifest 及实际 venv
closure。旧 `pi67-hy-memory-runtime/v1` 不会被删除，inventory 标记为
`legacy-unlocked`，仍可作为兼容读取或 rollback 目标，但新 init/upgrade 不再创建
unlocked generation。旧 `current.json` 没有完整 wrapper 字段时仍会
计算完整 hash，并至少要求其与 generation 名中的 content-hash 前缀一致。校验失败不会
自动删除 generation；`memory status` 会保持 `ready: false` 并提示运行
`pi-67 memory upgrade --force` 创建或重新绑定完整受管代。

`planId` 只是 dry-run 快照身份，不是删除授权。响应固定为 `executable: false`，
`blockedReasons` 始终包含 `deletion-not-implemented`，代码中没有删除路径。不要根据
目录名称手工删除 current、previous 或正在运行的 generation。真正 prune 仍需要
runtime import、service identity、deep probe、不可变执行 ledger、显式 `--yes` 和
可验证回滚门禁。

### Python lock 的平台边界

canonical 输入是 `extensions/pi-hy-memory/python/requirements.in`；目标 lock、resolver
cutoff、hash、distribution count 和 native qualification 状态在
`extensions/pi-hy-memory/python/lock-manifest.json`。安装固定使用 `--require-hashes`、
`--only-binary :all:`，并移除可能改变 index/hash 行为的 `PIP_*`/`UV_*` override。
`langdetect==1.0.9` 没有官方 wheel，因此仓库只 vendor 从官方 PyPI sdist 构建的
pure-Python wheel；source/wheel SHA-256 和 builder provenance 在
`python/vendor/provenance.json`。

截至 2026-07-31：

- `cp311-macos-arm64`、`cp311-manylinux_2_28-x64` 与 `cp311-windows-x64` 均已在
  对应原生 CI runner 完成 hashed、wheel-only clean install，`qualified=true`；
- macOS x64、Linux ARM64/musl、Windows ARM64 和其他 target fail closed，不会套用
  另一平台的 lock。pi-67 主产品的平台支持不自动等于可选 Hy-Memory Python closure
  已认证。

维护者可离线检查 tracked lock：

```bash
npm run check:hy-memory:python-lock
```

native clean install 只写隔离 temp generation，不启动 provider/service：

```bash
PI67_HY_MEMORY_PYTHON_INSTALL_TEST=1 \
node --test tests/pi-hy-memory/integration/python-runtime-install.test.mjs
```

### 性能基准边界

可复现入口：

```bash
npm run benchmark:hy-memory -- --python-generation --output /tmp/pi67-hy-memory-benchmark.json
```

2026-07-31 在 Mac ARM64（Apple M4 Pro、Node 24.18.0、Python 3.11.12）使用 isolated
fake SDK 测得：authenticated cold start 约 `94 ms`、idle RSS 约 `31 MiB`；search
25 次 `p50 0.69 ms / p95 1.18 ms`，capture 20 次
`p50 1.20 ms / p95 1.70 ms`；单 SDK worker 的 8 请求队列约 `81 ops/s`。operation
ledger 100/1000 条重启加载约 `1.9/18.1 ms`，磁盘约 `55/553 KiB`；outbox 1/5/20
条 drain 约 `0.8/1.7/5.4 ms`。20 个同时请求会触发 bounded handler capacity，实测
10 接受、10 返回 503，不是 connection abort。

Mac Python generation 的 logical size 约 `420 MiB`、12790 files、97 distributions；
current + previous 两代会接近翻倍，因此保留旧代具有明确磁盘成本。以上是
`MEASURED` 的本机/fake-SDK evidence，不代表 Windows/Linux、真实 provider latency
或真实 SDK database/JSONL 长期增长。ledger prune、directory count 和 runtime
inventory 都是有硬上限但随文件数增长的同步扫描；当前 1000 条/20 generations 数据
未显示需要复杂索引，暂不为形式优化重构。pipeline JSONL/history 长期增长仍属于
`F-DATA-001`，需要上游 SDK 公共控制面或独立长期观测。

## “自迭代/自进化”的真实边界

Hy-Memory 会从 settled conversation 抽取内容，并在 SDK 内对事实做新增、更新、
冲突整理；显式 `digest --yes` 还能执行更重的内容组织。这是“记忆内容演化”，
不是系统策略自主进化。当前实现不会自行评估召回质量、修改 recall threshold、
改写 prompt、切换模型、自动运行 digest，或用真实用户数据训练自身。

仓库已有不含真实记忆正文的 deterministic golden evaluation：

```bash
npm run test:hy-memory:eval
```

它覆盖 must-recall、must-not-recall、stale/superseded fact、capture
accept/reject、credential redaction、memory fence stripping，以及
latency/request/cost 结果 schema。deterministic adapter 不发送外部请求，结果固定
标记 `semanticQualityClaim: false`；它只证明评测控制面、fixture 和本地捕获策略
可回归，不能冒充真实 embedding/LLM 语义质量。

真实 provider evaluation 有独立入口，但默认 fail closed。先创建一个全新的空目录并
写入受控 marker，再使用正常 `memory init` 合同初始化这个一次性 home：

```bash
export EVAL_HOME=/absolute/path/to/disposable-hy-memory-home
mkdir -m 700 "$EVAL_HOME"

PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY=1 \
PI67_HY_MEMORY_EVAL_HOME="$EVAL_HOME" \
npm run eval:hy-memory:provider -- --prepare-home

PI67_HY_MEMORY_HOME="$EVAL_HOME" \
PI67_HY_MEMORY_EMBEDDING_API_KEY="$SILICONFLOW_API_KEY" \
pi-67 memory init

PI67_HY_MEMORY_EVAL_ALLOW_NETWORK=1 \
PI67_HY_MEMORY_EVAL_SYNTHETIC_ONLY=1 \
PI67_HY_MEMORY_EVAL_HOME="$EVAL_HOME" \
npm run eval:hy-memory:provider
```

三个变量缺少任意一个都不会发请求。`PI67_HY_MEMORY_EVAL_HOME` 必须是已经初始化、
service 正在运行且 active memory 数为 0 的独立绝对路径；入口拒绝真实
`~/.hy-memory/pi67` 及其父子路径，不读取 `PI67_HY_MEMORY_HOME` 作为 fallback。
`--prepare-home` 本身不启用网络，只接受现存空目录，并写入绑定当前 canonical fixture
SHA-256 的 `.pi67-hy-memory-provider-evaluation.json`；正式评测缺少或篡改该 marker
会直接拒绝。
它只写入 `golden-cases.json` 中 active 且 recall-eligible 的合成事实，不写入
synthetic secret，不打印 query、memory content、credential 或 provider response，
只输出 case ID、指标和分类错误。入口不会关闭 service、清理数据或删除 home，
因此应使用一次性 isolated home，不要复用任何个人记忆目录。

provider 结果标记 `mode: isolated-provider`、`corpusScope: isolated-synthetic`；
`semanticQualityClaim: true` 只表示当前固定 provider/runtime 对这组合成 fixture 的
语义行为，不外推到真实用户语料。入口只 seed active eligible facts；superseded facts
不会写入，因此这一阶段验证召回与排除门禁，不证明真实的冲突更新/历史淘汰效果。
`providerOperationRequests` 只统计 capture/search
操作；单次操作可能扇出为多个请求。由于 SDK 没有暴露可信的 provider request、
token 或 cost usage，结果将 `externalProviderRequests` 和 `estimatedCostUsd` 保持为
`null`，不能把它们解释成零请求或零成本。该命令可能产生真实
DeepSeek/SiliconFlow 请求和费用，普通测试、CI、install/update/repair 均不会调用。

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
2. 更新固定 SDK 版本、canonical `requirements.in` 和顶层 wheel SHA-256；使用固定
   `uv 0.7.6`、Python 3.11、target triple、`--generate-hashes`、`--only-binary :all:`
   与 `--exclude-newer 2026-07-31T00:00:00Z` 重新生成每个平台 lock，并更新 manifest；
3. 保持 DeepSeek/SiliconFlow provider 合同和 BGE-M3 dimensions 特例；
4. 在隔离的 `PI67_HY_MEMORY_HOME` 做新的 Python 3.11 runtime init、真实
   embedding probe、capture、search、restart 和 upgrade；
5. 对每个 target 在 native runner clean install，生成并校验 `python-runtime.json`，
   通过后才把对应 `qualified` 改为 `true`；
6. 运行 deterministic golden evaluation、TypeScript、Node、Python wrapper、
   lock check、PowerShell、packed artifact、release-check 和完整 smoke；
7. 发布新的 pi-67 版本。员工先 `pi-67 update`，再运行
   `pi-67 memory upgrade`；用户 config、secrets、data 和 outbox 必须保留。

不得把 SDK 版本改成范围依赖或启动时自动安装 `latest`。如果数据结构需要
迁移，必须先增加显式备份、兼容读取、回滚和干净基线复现，不能用当前的
普通 `memory upgrade` 隐式执行破坏性迁移。
