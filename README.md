# pi-67

pi-67 是围绕 upstream Pi 的团队工作台发行与配置管理器。它交付规则、
prompts、默认扩展、共享 Skills、诊断脚本和可回滚的版本化工作区；日常交互
入口始终是独立安装的 `pi`。

当前发行版版本：`0.15.2`。

## 产品边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| upstream `pi` | 聊天运行时、模型连接、认证、扩展加载、工具执行、session 生命周期 | pi-67 的发行资产与升级策略 |
| `pi-67` | `~/.pi/agent` 工作台、默认扩展最低基线、共享 Skills、规则、模板、诊断、迁移与回滚 | 安装、更新、比较、推荐或约束 Pi 版本 |
| 用户本机状态 | provider/model/theme/auth/MCP/session、自行升级的扩展和 Skills | 被 pi-67 静默覆盖或降级 |

Pi 与 pi-67 是两个独立产品。`pi-67 doctor` 只允许检查 `pi` 命令是否存在；
深度扩展诊断可通过真实 `pi list --no-approve` 验证已配置 package 是否被 Pi
解析，但不会读取或比较 Pi 版本。

## 0.15.x 的核心架构

### Manager 自带不可变发行版

`@bigking67/pi-67` npm artifact 内置与 manager 同版本的 distro。安装与更新从
当前 manager artifact 激活发行资产，不再 clone、pull 或追踪 GitHub `main`：

```text
~/.pi/pi67/
├── current.json
├── extension-ledger.json
├── pending-activation.json       # 仅在中断恢复期间存在
├── releases/<version>/           # 不可变发行资产
├── journals/                     # 激活记录
├── migrations/                   # legacy layout 迁移记录
└── backups/                      # legacy checkout 与显式恢复备份
```

上面是 canonical `~/.pi/agent` 的兼容路径。显式使用其他 `--agent-dir` 时，
pi-67 把 pointer、ledger、locks、journals、migrations、backups、reports 和
runtime state 隔离到
`~/.pi/pi67/workspaces/<sha256(agentDir) 前 16 位>/`。同一路径稳定映射，不同
工作台不会共享或覆盖状态；可用 `pi-67 version --json` 或
`pi-67 status --json` 查看实际 `paths.stateDir`。

同一版本已存在但内容不同会 fail closed。重复激活当前版本是 no-op。逐文件原子
替换期间会写入 pending marker；中断后再次执行可幂等恢复。`current.json` 只在
package-owned 文件全部落盘后更新。

### 默认扩展是最低基线，不是强制锁版本

0.15.0 保留全部 21 个默认扩展：17 个 package/Git 扩展和 4 个 pi67-first-party
扩展。更新状态机只做安全的最低基线收敛：

| 本机状态 | `pi-67 update` 行为 |
| --- | --- |
| missing | 安装发行版最低基线 |
| safely behind，且仍是 pi-67 上次管理的 pristine 内容 | 升级到最低基线 |
| at baseline | 保持不变 |
| newer / ahead | 保持不变，绝不降级 |
| lower/equal 但 modified/diverged | 保持不变，报告冲突 |
| source changed / fork / unknown | 视为用户管理，保持不变 |
| Pi 深度加载探针未解析已配置 package | 标记 `load-failed`，不自动覆盖 |

基线定义位于
`packages/pi67-cli/src/data/managed-extension-baselines.json`；本机所有权账本位于
当前工作台的 `stateDir/extension-ledger.json`（canonical 工作台即
`~/.pi/pi67/extension-ledger.json`）。账本只记录 pi-67 实际安装或确认过的
版本、commit 和内容 hash，不把未知目录猜成可覆盖对象。

兼容性 patch 只会在 pi-67 刚安装或安全升级精确匹配版本/内容的
`pi-until-done`、`pi-smart-fetch` 后执行，不会修改用户 ahead/diverged 副本。

### 21 个默认扩展

| ID | 来源 | 0.15.0 最低基线 | 角色 |
| --- | --- | --- | --- |
| `pi-subagents` | npm | `0.34.0` | subagents |
| `pi-observational-memory` | npm | `3.0.3` | session 内观察与压缩 |
| `pi-until-done` | npm | `0.2.2` | goal loop |
| `pi-fff` | npm | `0.9.6` | 文件检索 |
| `pi-web-access` | npm | `0.13.0` | Web access |
| `pi-smart-fetch` | npm | `0.3.12` | 内容抓取 |
| `rpiv-advisor` | npm | `1.20.0` | review/advisor |
| `pi-simplify` | npm | `0.2.2` | code simplification |
| `pi-plan-mode` | npm | `0.11.0` | planning |
| `pi-sequential-thinking` | npm | `5.0.3` | structured thinking |
| `pi-image-gen` | Git | `1128581…` | image generation |
| `pi-btw` | npm | `0.11.0` | side question |
| `pi-rewind` | Git | `91611ad…` | session rewind |
| `pi-mcp-adapter` | npm | `2.11.0` | MCP adapter |
| `pi-curated-themes` | npm | `0.2.1` | themes |
| `pi-markdown-preview` | npm | `0.10.0` | Markdown preview |
| `rpiv-ask-user-question` | npm | `1.20.0` | structured input |
| `xtalpi-pi-tools` | bundled | `0.15.0` | first-party provider/tools |
| `pi-vision-bridge` | bundled | `0.15.0` | first-party vision bridge |
| `pi-rules-loader` | bundled | `0.15.0` | first-party rule routing |
| `pi-hy-memory` | bundled | `0.15.0` | cross-session long-term memory |

完整 commit 与 SHA-256 以 baseline registry 为准，表格中的 Git commit 仅为短写。

## 记忆边界

公共发行版默认提供两个互补层，不互相替代：

1. `pi-observational-memory`：单个 session 内的观察、整理和压缩。
2. `pi-hy-memory`：跨 session 的长期记忆、召回与写回。

个人 `agent_memory` MCP 不属于公共产品：

- 不进入 `mcp.example.json`、manifest、baseline registry 或公共安装指引；
- 不由 install/update/migrate/repair 创建、删除或覆盖；
- 如果用户已在 ignored `~/.pi/agent/mcp.json` 中配置，迁移和回滚原样保留；
- 数据、凭据和私有存储从不进入 npm artifact 或 Git。

Hy-Memory 的运行与隐私细节见 `docs/hy-memory.md`。

## 默认 Skills

发行版当前内置 62 个 shared Skills。更新默认只补齐 missing；已有同名内容不同的
active Skill 被视为用户维护版本并保留。`--strict-shared-skills` 可把冲突提升为
blocker，但仍不会覆盖。

必须保留的核心集合：

- 27 个 Lark/飞书 Skills，包含 `lark-apps` 与 `lark-note`；
- 8 个 Commerce/Marketing Skills；
- 21 个 AI Berkshire 投资研究 Skills；
- 其余公共工作台 Skills。

Commerce/Marketing 与 AI Berkshire 均为 `owner=pi67-first-party`、
`distribution=bundled-release-only`。它们没有需要在用户更新路径自动拉取的第三方
runtime upstream；只有 pi-67 维护者更新并发布新 baseline 后，用户才会收到新版。

查看治理状态：

```bash
pi-67 skills inventory
pi-67 skills packs --json
pi-67 skills plan
pi-67 skills diff <skill-name>
```

显式覆盖 Skill Pack 仍需要用户确认：

```bash
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
pi-67 skills sync-pack ai-berkshire-investment-suite --dry-run
pi-67 skills sync-pack ai-berkshire-investment-suite --yes
```

## 安装

### 前提

- Node.js 22.19+ 或 Node.js 24 LTS；
- `pi` 已由用户独立安装并可执行；
- npm 可访问 `@bigking67/pi-67`；
- Git 仅供 Git 类型第三方扩展或开发/维护使用，不再用于取得 pi-67 distro。

pi-67 不安装 Pi。Pi 的安装、升级和版本选择必须由用户按 upstream 方式独立维护。

### 全新安装

正式发布后：

```bash
npm install -g @bigking67/pi-67@0.15.2
pi-67 install
pi-67 doctor --json
pi
```

`pi-67 install` 只激活 manager 内置的 immutable distro、安装 missing/default
最低扩展基线并补齐 missing Skills。如果 `~/.pi/agent` 是非空 legacy checkout，
命令会 fail closed 并引导先迁移。

### 从 legacy Git checkout 迁移

```bash
pi-67 migrate --check --json
pi-67 migrate --yes
pi-67 doctor --json
```

迁移会把原 checkout 移到
`<stateDir>/backups/<timestamp>-runtime-layout/legacy-agent`，再激活 manager 内置
distro，并复制保留 `settings.json`、`models.json`、`auth.json`、`mcp.json`、
`image-gen.json`、theme、`extensions/`、`git/`、`npm/`、`sessions/`。

需要恢复 legacy layout：

```bash
pi-67 rollback --migration --check
pi-67 rollback --migration --yes
```

## 更新与回滚

更新 manager 与更新 distro 是一条明确链路：先由用户显式更新 npm manager，再由
该 manager 激活它自带的同版本 distro。pi-67 不自行管理 Pi。

```bash
pi-67 self-update --dry-run
pi-67 self-update
pi-67 update --check --json
pi-67 update
```

常用选项：

```bash
pi-67 update --repair
pi-67 update --no-npm
pi-67 update --check --no-remote --json
pi-67 update --check --strict-shared-skills --json
```

`--repair` 重新应用安全且可证明的 package-owned 资产，不会执行整个 runtime
`npm ci`，也不会把用户更高版本扩展同步回旧 release lock。`--no-npm` 只跳过
npm extension 的安装/升级，仍可检查和处理其他发行资产。

回滚上一 immutable distro：

```bash
pi-67 rollback --check --json
pi-67 rollback --yes
```

## 扩展诊断与显式恢复

```bash
pi-67 extensions list --json
pi-67 extensions plan --json
pi-67 extensions status --deep --json
pi-67 extensions doctor --deep --json
pi-67 extensions inspect <id> --json
pi-67 extensions diff <id> --json
pi-67 extensions restore <id> --check --json
pi-67 extensions restore <id> --yes
```

`restore` 是唯一覆盖单个 diverged/default extension 的 manager 命令：先备份，只
替换指定 ID，不影响其他 ahead、diverged 或 unknown 扩展。

## 用户状态保护

下列状态不属于公共模板的强制覆盖面：

```text
settings.json
models.json
auth.json
mcp.json
image-gen.json
settings.json.theme
extensions/
git/
npm/
sessions/
```

模板文件仅用于首次缺失时创建：`settings.example.json`、`models.example.json`、
`auth.example.json`、`mcp.example.json`、`image-gen.example.json`。主题更新保留
`settings.json:theme`；provider/auth/model selection 完全由 upstream Pi 管理。

## 状态与诊断

```bash
pi-67 version --json
pi-67 status --json
pi-67 manifest --json
pi-67 manifest --validate
pi-67 update --check --json
pi-67 doctor --json
pi-67 extensions doctor --deep --json
pi-67 backups list --json
```

`version` 的 schema 为 `pi67.version.v2`，只报告 manager/distro/Node/platform/theme，
不包含 Pi 版本。`update --check` 是 no-write 计划；`status` 是轻量只读摘要；
`doctor` 才执行更深的配置和运行态检查。

## Windows

PowerShell 入口：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& "$env:USERPROFILE\.pi\agent\scripts\pi67-bootstrap.ps1"
pi-67 migrate --check --json
pi-67 update --check --json
& "$env:USERPROFILE\.pi\agent\scripts\pi67-doctor.ps1" -Json
& "$env:USERPROFILE\.pi\agent\scripts\pi67-smoke.ps1" -Ci
& "$env:USERPROFILE\.pi\agent\scripts\pi67-windows-acceptance.ps1"
```

`pi67-bootstrap.ps1` 只 bootstrap pi-67 manager/workspace，不安装或升级 Pi。完整步骤见
`docs/windows-fresh-install.md`。

## browser67 与 xtalpi

browser67 是独立 external repo，使用显式生命周期：

```bash
pi-67 external install browser67 --dry-run
pi-67 external install browser67 --yes
pi-67 external doctor browser67 --deep
```

dirty external checkout 不会被 reset/clean/覆盖。

`xtalpi-pi-tools` 是可选 provider/tool convenience，不是启动 Pi 的前提：

```bash
pi-67 xtalpi configure --verify
pi-67 xtalpi smoke --quick
```

真实 credentials 只能存放在 machine-owned、repo 外的受保护状态中。

## 开发与发行验证

```bash
node packages/pi67-cli/scripts/check.mjs
npm run typecheck:xtalpi
npm run typecheck:hy-memory
npm run test:rules-loader
npm run test:xtalpi
npm run test:hy-memory
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-check.sh
bash scripts/pi67-release-artifact-smoke.sh
```

npm 发布前必须从 packed artifact 做隔离安装与真实 CLI smoke；源码 checkout 通过不
等于 npm artifact 可用。发行流程见 `docs/release.md`，包括 `pi-67 publish-check`、
Trusted Publishing、exact/latest dist-tag 和 GitHub Release 资产校验。

## 目录职责

```text
packages/pi67-cli/      npm manager、CLI、schemas、artifact bundle 构建
extensions/             4 个 pi67-first-party extensions
shared-skills/          发行版内置 Skills 真源
rules/                  Pi 按需加载的跨项目规则
scripts/                跨平台诊断、smoke、release 与维护脚本
docs/                   安装、schema、故障排查与治理文档
tests/                  extension/rule/runtime 回归测试
```

当前常驻 `AGENTS.md` kernel 为 `v1.8-pi`，按需路由 11 个 `rules/*.md` 长规则；
`pi-rules-loader` 只注入与任务直接匹配的最小规则集合。

治理清单：`rules/` (11 篇)。

不要把生成的 `distro/`、npm tarball、日志、临时 HOME、真实 credentials、
`mcp.json` 或 session 数据提交到源码。嵌套第三方 Git checkout 保持独立，不修改其
lockfile 来完成 pi-67 发布。

## 进一步文档

- `docs/full-install.md`：macOS/Linux/Windows 完整安装与迁移。
- `docs/windows-fresh-install.md`：Windows fresh install。
- `docs/troubleshooting.md`：诊断与恢复决策树。
- `docs/doctor-schema.md`：doctor JSON v2。
- `docs/status.md`：status/update plan 语义。
- `docs/report-schema.md`：报告 schema。
- `docs/skill-governance.md`：Skills 与 first-party Pack 治理。
- `docs/hy-memory.md`：跨 session 长期记忆。
- `docs/release.md`：维护者发行流程。

## License

见 `LICENSE`。第三方扩展与 vendored Skills 的独立 license/provenance 以各自目录和
lock metadata 为准。
