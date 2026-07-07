# pi-67 — Pi Coding Agent 配置一站通

[![ci](https://github.com/bigKING67/pi-67/actions/workflows/ci.yml/badge.svg)](https://github.com/bigKING67/pi-67/actions/workflows/ci.yml)

> 我的 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) full-stack 工作台发行版：默认安装完整 Pi 最佳配置，再用 doctor 判断哪些能力已经就绪。

当前发行版版本：`0.10.0`（见 `VERSION` 和 `CHANGELOG.md`）。

## 这是什么

这个仓库把 `~/.pi/agent/` 中可复用、可公开的 Pi 配置整理成可安装版本。推荐长期形态是 `~/.pi/agent` 本身就是这个 Git checkout；它不是 minimal starter，而是完整 Pi 工作流发行包：

- 常驻内核：`AGENTS.md` 只保留硬规则、工具分流、rules 读取契约和交付闭环。
- 长规则外置：`rules/` 存放质量、架构、目录、性能、前端、浏览器、上下文、数据和电商增长规则，按任务最小读取。
- 扩展补强：`extensions/pi-rules-loader/` 给 Pi 注入 rules 索引；`extensions/xtalpi-pi-tools/` 让 Pi 本地托管 xtalpi 工具协议。
- 生产力资产：Skills、Prompts、Docs、Templates 和脚本保持仓库化，便于审计、同步和回滚。

仓库不会提交真实 `auth.json`、`models.json`、`mcp.json`、`image-gen.json`、会话、缓存或运行历史；只提供 `.example` 模板。

默认安装是 **full install**：所有最佳配置都会部署。缺 API key、本地 MCP repo 或外部二进制时，不裁剪配置，而是由 `scripts/pi67-doctor.sh` 报告 readiness warning。安装器支持两种模式：

- **in-place repo**：`REPO_ROOT == ~/.pi/agent`，可发布资产是 Git tracked 文件，本机配置/缓存/会话由 `.gitignore` 排除。
- **linked install**：外部 checkout 通过 symlink 映射到 `~/.pi/agent`，保留给兼容旧安装。

## 包含内容

| 类别 | 内容 | 说明 |
|------|------|------|
| **核心配置** | `settings.json` | 默认 provider/model、Pi package 列表 |
| **模型配置** | `models.example.json` | xtalpi-pi-tools / codex provider 模板 |
| **MCP** | `mcp.example.json` | browser67 tmwd_browser、js-reverse、agent_memory 模板 |
| **全局内核** | `AGENTS.md` | Pi 常驻行为规范（v1.5-pi kernel） |
| **Rules** | `rules/` (9 篇) | 质量、架构、结构、性能、前端、浏览器、上下文、数据质量、电商增长规则 |
| **自定义扩展** | `extensions/` (2 个) | `xtalpi-pi-tools` + `pi-rules-loader` |
| **Shared Skills** | `shared-skills/` (32 个) | 安装到 `~/.agents/skills`，供 Pi/Codex 共用 |
| **Skill 治理** | `docs/skill-governance.md` | skill 公开发行 / 个人 overlay / 过期治理规则 |
| **文档** | `docs/` | 全量安装、doctor/report/status schema、排障、发布流程、MCP 优化、爬虫指南、工具速查、xtalpi 配置 |
| **Prompts** | `prompts/` (5 个) | debug、deliver、frontend-kickoff、review、scoped-commit |
| **脚本** | `scripts/` | configure、doctor、report、status、skill-audit、skill migration/sync/check、release artifact smoke、release、release-check、smoke、update、restore、uninstall、xtalpi-pi-tools 启动、测试和冒烟测试 |
| **模板** | `templates/scrapers/` | 采集/合并/轮询相关脚本模板 |

## Shared skill registry

pi-67 的共享 skill 统一安装到全局 active root：

```text
~/.agents/skills
```

Pi 和 Codex 都从这里发现共享 skill；`~/.pi/agent` 只保存 Pi 的
`AGENTS.md`、rules、prompts、extensions、scripts、MCP/config 模板和运行态。
仓库里的 `shared-skills/` 是发布源，安装器默认复制到 `~/.agents/skills`。
`--dev-link-skills` 只用于本机开发模式，普通安装不使用 symlink。
如果 doctor 提示全局 skill 内容与 pi-67 发布源不同，可以用只读 inventory
解释差异而不覆盖全局 skill：

```bash
bash ~/.pi/agent/scripts/pi67-shared-skills-inventory.sh
bash ~/.pi/agent/scripts/pi67-shared-skills-inventory.sh --json
```

来自独立仓库的 skill 也应安装到同一个全局 root：

```text
~/.agents/skills/design-craft
~/.agents/skills/frontend-craft
~/.agents/skills/tmwd-browser-mcp
~/.agents/skills/js-reverse
```

因此长期规则是：

- `~/.agents/skills`：唯一跨 agent active skill registry。
- `~/.pi/agent/skills`：不再使用；出现时视为 legacy duplicate。
- `design-craft` / `browser67`：不要作为 Pi active package 重复声明；普通用户把其中的 skills 安装到 `~/.agents/skills`。
- browser67 MCP：在本机 ignored `mcp.json` 里配置源码路径；默认模板指向 `~/.agents/packages/browser67/src/mcp/...`，也可用 `pi67-configure --tmwd-repo` 改到任意 checkout。

旧安装如果已经出现 duplicate / conflict / skipped / `auto (user)` 之类
`pi skill list` 警告，先用迁移工具预览；它默认 dry-run、只复制缺失 skill、
遇到内容冲突会停止，不会覆盖 `~/.agents/skills`：

```bash
bash ~/.pi/agent/scripts/pi67-migrate-skills.sh --dry-run
bash ~/.pi/agent/scripts/pi67-migrate-skills.sh --apply --yes
```

独立仓库里的 skills 用同步工具安装到全局 active root，而不是把仓库声明成
Pi active package source：

```bash
bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67 \
  --dry-run
```

同步工具同时支持 `repo/SKILL.md` 这种 root-level skill 仓库，例如
`commerce-growth-os`：

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/commerce-growth-os

bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/commerce-growth-os \
  --dry-run
```

维护 pi-67 vendored 发行副本时，用专门 helper 从上游 checkout 刷新
`shared-skills/commerce-growth-os`；普通用户更新 pi-67 不需要执行这个：

```bash
bash ~/.pi/agent/scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

需要先检查真实外部仓库和当前 `~/.agents/skills` 是否会冲突时，用只读检查器：

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67
```

## 快速开始

### 前置条件

Windows 用户默认使用 PowerShell；macOS/Linux 用户继续使用 Bash 示例。

```bash
# 已安装 pi
npm install -g @earendil-works/pi-coding-agent

# 首次运行 pi 生成 ~/.pi/agent/ 目录
pi --version
```

PowerShell 等价命令：

```powershell
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### 首选：npm 管理器 `pi-67`

面向普通用户和长期维护，推荐先安装 pi-67 的 npm 管理器。它只提供
`pi-67` / `pi67` 命令，不覆盖 Pi 官方 `pi` 命令：

```bash
npm install -g @bigking67/pi-67
pi-67 install
pi-67 update
pi-67 doctor
pi-67 smoke --quick
```

Windows PowerShell 使用同一套命令：

```powershell
npm install -g @bigking67/pi-67
pi-67 install
pi-67 update
pi-67 doctor
pi-67 smoke --quick
```

长期边界：

- `pi update` / `pi update --extensions` 是 Pi 官方上游更新命令。
- `pi-67 update` 是 pi-67 发行版主更新命令。
- 如果误跑了 `pi update --extensions`，再运行 `pi-67 update --repair` 重新对齐 pi-67 管理状态。

`pi-67 update` 默认不覆盖用户本地选择：现有 `models.json`、`auth.json`、
`mcp.json`、`image-gen.json`、用户添加的 packages、全局 skills 和
`settings.json.theme` 都会保留。主题只在显式执行下面命令时改变：

```bash
pi-67 themes set gruvbox-dark
```

如果要在 CI 或发布前把 shared skills 差异视为阻断，而不是默认保留用户已有
版本，可显式执行：

```bash
pi-67 update --strict-shared-skills
```

脚本入口仍然保留，作为 CI、bootstrap 和高级排障使用；普通用户优先记
`pi-67 update`、`pi-67 doctor`、`pi-67 smoke --quick`。

如果本机安装的 npm 管理器本身落后，`pi-67 update --check` 会提示更新。
显式更新管理器用：

```bash
pi-67 self-update
```

如果想完全绕过本机旧管理器，直接用 npm 最新版执行一次修复更新：

```bash
npx -y @bigking67/pi-67@latest update --repair
```

管理器的轻量状态文件写到 repo 外：

```text
~/.pi/pi67/state.json
```

它只记录版本、commit、theme、provider/model 和本地路径，不保存 API key。

### 推荐：原地 checkout 到 `~/.pi/agent`

Windows PowerShell：

```powershell
git clone https://github.com/bigKING67/pi-67.git $env:USERPROFILE\.pi\agent
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-smoke.ps1 -Ci
```

`scripts\pi67-smoke.ps1` 是 Windows 的一等验证入口：它用 PowerShell + Node.js
做 repo metadata、JSON、xtalpi endpoint contract、Node helper 和 portability
检查，不要求额外 Unix-like shell，也不依赖本机 `/Users/...` 或 npm package 绝对路径。

Windows 更新入口是 PowerShell-native 的 `scripts\pi67-update.ps1`。它会执行
fast-forward Git 更新、保留本地 `models.json` / `auth.json` / `mcp.json` /
`image-gen.json`、在备份后把 UTF-16 / UTF-8 BOM / 前导 NUL 这类本地 JSON
编码问题规范化为 UTF-8 without BOM、同步缺失模板和 npm 依赖、运行 PowerShell
smoke，并覆盖写入 `pi67-report.json`。Windows 也可以直接用
`scripts\pi67-doctor.ps1` 做日常 readiness 诊断；完整 Bash installer 仍服务
macOS/Linux 和需要 symlink 安装的场景。

macOS/Linux：

```bash
git clone https://github.com/bigKING67/pi-67.git ~/.pi/agent
cd ~/.pi/agent
./install.sh --agent-dir "$PWD"
```

这种模式下不会把 Pi runtime 资产创建成 symlink；`AGENTS.md`、`rules/`、`shared-skills/`、`scripts/` 等都是当前 checkout 的 tracked assets。安装器会把 `shared-skills/` 复制到 `~/.agents/skills`。`models.json`、`mcp.json`、`auth.json`、`image-gen.json`、`sessions/`、`npm/` 等本机运行态会被 ignored。

长期维护流：

Windows PowerShell：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
git status --short --branch
.\scripts\pi67-smoke.ps1 -Ci
git add <scoped files>
git commit -m "..."
git push origin main
```

macOS/Linux：

```bash
cd ~/.pi/agent
git status --short --branch
bash scripts/pi67-smoke.sh --ci
git add <scoped files>
git commit -m "..."
git push origin main
```

### 兼容：外部 checkout 安装

```bash
git clone https://github.com/bigKING67/pi-67.git
cd pi-67
chmod +x install.sh
./install.sh
```

安装脚本会：

1. 检查 `pi`
2. 自动判断 in-place 或 linked 模式
3. in-place 模式验证 tracked assets；linked 模式备份并创建 symlink
4. 复制缺失的本地配置文件（从 `.example` 文件复制）
6. 安装 npm 扩展包
7. 运行 `scripts/pi67-doctor.sh`
8. 生成 `~/.pi/agent/pi67-report.json`

常用选项：

```bash
./install.sh --yes                         # 自动化场景
./install.sh --dry-run --no-npm --no-doctor # 只预览，不写入
./install.sh --no-npm                      # 跳过 npm install
./install.sh --no-report                   # 不生成 pi67-report.json
./install.sh --agent-dir /path/to/.pi/agent # 安装到自定义 Pi agent 目录
./install.sh --strict-shared-skills        # shared skill 内容不一致时阻断
```

默认情况下，若 `~/.agents/skills/<name>` 已有同名 skill 但内容与
pi-67 打包基线不同，安装器会保留已有全局 skill、打印 WARN 并继续。
这避免把目标电脑上可能更新、更可信的全局 skill 降级为 pi-67
发行包里的旧副本。只有需要强制核对 pi-67 打包基线时，才使用
`--strict-shared-skills`。

安装后运行：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
bash ~/.pi/agent/scripts/pi67-doctor.sh
```

Windows PowerShell 日常诊断：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-doctor.ps1
.\scripts\pi67-doctor.ps1 -Json
.\scripts\pi67-report.ps1 -Operation manual
```

doctor 会区分：

```text
PASS = 已安装且可用
WARN = 已安装但需要本机 key / 路径 / 依赖
FAIL = 阻断性问题
```

自动化/CI 可用：

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --quiet # 只看 summary/result
bash ~/.pi/agent/scripts/pi67-doctor.sh --json  # 机器可读 readiness JSON
```

只想快速看当前安装是否需要更新、报告是否过期、doctor 上次结果如何：

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
bash ~/.pi/agent/scripts/pi67-status.sh --json
```

`pi67-status.sh` 会把仅由 `settings.json` 的 `lastChangelogVersion` /
trailing-newline 引起的 dirty 状态标成 `local runtime state only`，不把它当作
普通本地改动阻断更新；其它 dirty 文件仍会正常报警。它还会从本地 xtalpi smoke
artifact 里汇总 provider-health retry/failure trend，帮助区分上游 timeout /
网络 / key 问题和 Pi 本地工具协议回归。

需要确认 MCP server 能真实启动并暴露工具时，显式开启深度探测：

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000
```

完整说明见 `docs/full-install.md`；常见问题见 `docs/troubleshooting.md`。

安装/更新后会写入当前状态报告：

```text
~/.pi/agent/pi67-report.json
```

这是单文件覆盖写，不会无限追加历史文件；里面记录 pi-67 版本、Git commit、agent 文件状态、runtime 版本和 doctor JSON 结果。

机器可读字段契约见：

- `docs/report-schema.md`：`pi67-report/v2`
- `docs/doctor-schema.md`：`pi67-doctor/v2`
- `docs/skill-migration-schema.md`：`pi67-skill-migration/v1`
- `docs/external-skill-sync-schema.md`：`pi67-external-skill-sync/v1`

本地/CI 维护检查：

```bash
bash scripts/pi67-smoke.sh
```

其中 skill governance fixture 和 release artifact 检查也可以单独运行：

```bash
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
```

### 本地配置向导

推荐先用配置向导把本地 key / MCP 路径写入 `~/.pi/agent` 的本地配置文件：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

自动化或无交互环境用 env，不要把 API key 放进 CLI 参数：

```bash
PI67_XTALPI_API_KEY="..." \
PI67_CODEX_API_KEY="..." \
PI67_DEEPSEEK_API_KEY="..." \
PI67_IMAGE_GEN_API_KEY="..." \
bash ~/.pi/agent/scripts/pi67-configure.sh \
  --no-prompt \
  --tmwd-repo "/path/to/browser67" \
  --agent-memory-bin "$HOME/.local/bin/agent-memory-mcp"
```

预览但不写入：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --dry-run --no-prompt
```

配置向导只修改本地运行态文件；它不会把密钥写入仓库。如果需要切换默认 provider/model：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --provider codex --model gpt-5.4 --prompt-secrets
```

注意：`settings.json` 默认是仓库 symlink；只有当你实际切换默认 provider/model 时，配置向导才会把它安全地拆成本地文件，避免把个人默认模型写回仓库。

也可以手动按 doctor 提示填写以下本地配置文件。它们不会提交到仓库：

```text
~/.pi/agent/models.json    <- 从 models.example.json 复制，填写 API key
~/.pi/agent/mcp.json       <- 从 mcp.example.json 复制，修改本地路径
~/.pi/agent/auth.json      <- 从 auth.example.json 复制，填写 DeepSeek key
~/.pi/agent/image-gen.json <- 从 image-gen.example.json 复制，填写 Codex key
```

## Rules 工作方式

Pi 的长期规则分两层：

1. `AGENTS.md` 是常驻内核，保持短小，定义不可外置的硬规则、工具分流、任务分级、Git 策略和交付闭环。
2. `rules/*.md` 是按需读取的长规则，由 `pi-rules-loader` 暴露索引，让 Pi 在 L1/L2 任务前按场景读取 1-3 个最相关文件。

默认读取策略：

| 任务场景 | 主要 rules |
| --- | --- |
| 常规代码修改、bugfix、重构 | `quality.md` |
| 架构方案、接口边界、迁移、兼容性 | `architecture-quality.md` + `project-structure.md` |
| 性能、慢查询、热路径、批处理、构建体积 | `performance.md` |
| 新增目录/文件、模块重组、共享抽象 | `project-structure.md` |
| 大日志、大 JSON、大 diff、长会话 | `context-budget.md` |
| 页面、组件、样式、交互、可访问性 | `frontend.md` |
| 登录态、真实 Chrome、下载/上传、JS 逆向 | `browser.md` |
| 数据口径、映射、唯一性争议 | `data-quality.md` |
| 电商增长、平台运营、货盘价盘、渠道控价、ROI/利润测算 | `commerce-growth.md` |

## 目录结构

```text
pi-67/
├── README.md
├── VERSION
├── CHANGELOG.md
├── install.sh                      # 一键符号链接安装脚本
├── .gitignore
├── AGENTS.md                       # Pi v1.5-pi 常驻内核
├── settings.json                   # Pi 核心配置
├── models.example.json             # 模型配置模板（需填写 API key）
├── mcp.example.json                # MCP 服务配置模板（需修改路径）
├── auth.example.json               # 认证配置模板（需填写 API key）
├── image-gen.example.json          # 图片生成配置模板（需填写 API key）
├── package.json                    # npm 扩展包依赖列表
├── extensions/
│   ├── pi-rules-loader/            # Rules 索引注入扩展
│   │   └── index.ts
│   └── xtalpi-pi-tools/            # xtalpi 本地工具协议 provider
│       ├── index.ts
│       ├── parser.ts
│       ├── serializer.ts
│       ├── protocol.ts
│       ├── retry.ts
│       ├── diagnostics.ts
│       └── stream.ts
├── rules/                          # Pi 按需读取长规则
│   ├── architecture-quality.md
│   ├── browser.md
│   ├── commerce-growth.md
│   ├── context-budget.md
│   ├── data-quality.md
│   ├── frontend.md
│   ├── performance.md
│   ├── project-structure.md
│   └── quality.md
├── shared-skills/                  # 32 个共享 Skills，安装到 ~/.agents/skills
│   ├── commerce-growth-os/         # 全域电商增长操盘 skill
│   ├── lark-*                      # 飞书全系列
│   ├── full-output-enforcement/
│   ├── high-end-visual-design/
│   ├── industrial-brutalist-ui/
│   ├── minimalist-ui/
│   ├── redesign-existing-projects/
│   └── stitch-design-taste/
├── docs/                           # 文档
│   ├── doctor-schema.md
│   ├── external-skill-sync-schema.md
│   ├── full-install.md
│   ├── mcp-optimization-spec.md
│   ├── report-schema.md
│   ├── release.md
│   ├── skill-governance.md
│   ├── skill-migration-schema.md
│   ├── scraping-guide.md
│   ├── status.md
│   ├── troubleshooting.md
│   ├── tool-cheatsheet.md
│   └── xtalpi-pi-tools.md
├── prompts/                        # Pi Prompt 模板
│   ├── debug.md
│   ├── deliver.md
│   ├── frontend-kickoff.md
│   ├── review.md
│   └── scoped-commit.md
├── scripts/
│   ├── pi67-check-external-skills.sh
│   ├── pi67-configure.sh
│   ├── pi67-doctor.sh
│   ├── pi67-doctor.ps1
│   ├── pi67-migrate-skills.sh
│   ├── pi67-release-artifact-smoke.sh
│   ├── pi67-release.sh
│   ├── pi67-release-check.sh
│   ├── pi67-report.sh
│   ├── pi67-report.ps1
│   ├── pi67-restore.sh
│   ├── pi67-skill-audit.sh
│   ├── pi67-smoke.ps1
│   ├── pi67-smoke.sh
│   ├── pi67-patch-pi-until-done-runtime-queue.mjs
│   ├── pi67-patch-pi-until-done-runtime-queue.ps1
│   ├── pi67-patch-pi-until-done-runtime-queue.sh
│   ├── pi67-status.sh
│   ├── pi67-sync-commerce-growth-os.sh
│   ├── pi67-sync-external-skills.sh
│   ├── pi67-test-skill-governance.sh
│   ├── pi67-update.sh
│   ├── pi67-update.ps1
│   ├── pi67-uninstall.sh
│   ├── pi67-xtalpi-pi-tools.sh
│   ├── pi67-test-xtalpi-pi-tools.sh
│   ├── pi67-xtalpi-pi-tools-smoke.sh
│   ├── pi67-xtalpi-pi-tools-smoke.ps1
│   ├── pi67-xtalpi-pi-tools-debug-summary.sh
│   ├── pi67-xtalpi-smoke-plan.mjs
│   ├── pi67-xtalpi-provider-health.mjs
│   └── pi67-xtalpi-provider-capability-probe.mjs
└── templates/
    └── scrapers/
```

## 关于 xtalpi

xtalpi 是晶泰科技内部 API。`models.example.json` 中只保留一个晶泰 provider：`xtalpi-pi-tools`。

`xtalpi-pi-tools` 不再向晶泰发送 OpenAI 原生 `tools` / `tool_choice` / `role=tool`，而是让晶泰只生成普通 Chat Completions 文本中的本地 JSON action；Pi 本地负责解析、校验、repair、错误分类和工具执行。运行时只保留 JSON action 单协议；旧 `<pi_tool_call>` 文本只作为 provider drift 输入被识别、拒绝并修复回 JSON action，不再提供可切换 fallback。

extension 工具识别不是写死名单：provider 每轮从 Pi runtime 的 `context.tools`
动态读取当前可调用工具，再按 prompt 做 selected-tool ranking。以后安装新 extension 时，
只要它通过 `registerTool` 出现在当前 turn 的 `context.tools`，`xtalpi-pi-tools`
即可识别并展示；如果工具被 `XTALPI_PI_TOOLS_MAX_TOOLS` 截断或当前 mode/flag 禁用，
它不会进入本轮执行白名单。新增工具建议先用 `--tools new_tool_name` 做 targeted smoke，
不要直接放进 full-suite release gate。
selected-tool ranking 会识别“不要调用 read/bash”这类负向工具约束；低 `MAX_TOOLS`
场景下，被用户明确禁止的工具会被降权，避免 targeted smoke 或新 extension 验收时误暴露。
正向工具名命中也按边界匹配，不会因为 `README.md` 这类普通文件名子串就把 `read`
误判为用户点名的工具。
如果当前 prompt 明确写了“只使用/only use 某个工具”，即使本轮工具总数低于
`XTALPI_PI_TOOLS_MAX_TOOLS`，provider 也只会展示这些 explicit-only 工具。
debug-summary 会聚合 selected / omitted 工具的 reason code，便于从 smoke artifact
直接核对 `prompt_tool_forbidden`、`prompt_tool_exclusive` 等 ranking 边界。
`full-suite-ranking-strict` trend profile 会把这些 reason code 纳入门禁，
防止 selected-tool ranking 规则漂移混进 full-suite artifact。
当前离线回归里也有一个 MCP direct-tool 形态的 `dyn_echo_ping` fixture，用来证明
未来 MCP direct tool 进入 `context.tools` 后会被 selected-tool ranking 选中并作为
本地 Pi 工具调用返回；同时还有一个两轮 round-trip 回归，覆盖“模型请求动态工具 ->
Pi 本地工具结果以不可信文本回灌 -> 模型基于 sentinel 给最终回答”的闭环。真实 MCP
server 的连接、鉴权和 cache 刷新仍由 `pi-mcp-adapter` 负责。测试还会在临时
`PI_CODING_AGENT_DIR` 写入隔离的 `mcp.json` / `mcp-cache.json`，加载真实
`pi-mcp-adapter` 源码并捕获它注册出的 direct tool，证明 adapter 注册出的工具对象
能进入 `xtalpi-pi-tools` 的 selected-tool / provider-turn 链路。

Windows PowerShell 的一等验证入口是 repo/endpoint contract smoke：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-smoke.ps1 -Ci
```

它不需要 Bash，也不依赖任何个人机器绝对路径。安装或更新 extension 后，先跑只读
smoke plan 看当前工具覆盖面：

```powershell
node .\scripts\pi67-xtalpi-smoke-plan.mjs
node .\scripts\pi67-xtalpi-smoke-plan.mjs --json
```

smoke plan 只读取 `settings.json`、本地 extension/package 源码和 package metadata；
不调用模型、不访问外网、不读取或修改 key/config。它会把当前 extension 分成
`covered_by_windows_targeted_smoke`、`partially_covered_by_windows_targeted_smoke`、
`manual_or_static_only`、`gateway_only_dynamic_tools_need_runtime_auth` 和
`not_model_callable` 等状态，并给出下一步推荐命令。它不能证明需要真实账号、鉴权、
交互、写文件、图片/预览 artifact 或 mutating action 的工具已经可安全自动调用；
这些工具仍要用隔离目录或人工场景单独验收。

Windows 还可以用 PowerShell-native
targeted live runner 验证低风险 extension 工具链路：

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -ListCases
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-expanded
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,plan-mode-contract,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
```

这个 PowerShell runner 覆盖 `read-package`、`plan-mode-contract`、`until-done-continuation`、`fffind-package`、
`ffgrep-package`、`batch-web-fetch-example`、`seq-thinking-status`、`mcp-status`、`subagent-list`
和 `recall-not-found` 这些低风险 targeted case，并为 FFF / sequential-thinking
使用临时隔离状态。PowerShell live runner 默认会对“工具调用、参数和 debug telemetry
都已正确但最终 assistant 文本为空”的瞬时模型/turn 结束抖动重试 1 次；可用
`-CaseRetries 0` 或 `XTALPI_PI_TOOLS_SMOKE_CASE_RETRIES=0` 关闭，不会重试
missing tool、错误参数、非零退出或 runtime error。完整 xtalpi full-suite runner 目前仍是 Bash 脚本；Windows 上
只有在显式具备 Bash-compatible shell 时才运行下面的 full-suite/live case，不要把
Git Bash 当成默认前置条件。下面 Bash 命令均假设已经在 agent repo 根目录。

显式启动：

```bash
bash ./scripts/pi67-xtalpi-pi-tools.sh
```

静态测试：

```bash
bash ./scripts/pi67-test-xtalpi-pi-tools.sh
```

真实冒烟：

```bash
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh
```

真实冒烟覆盖 no-tool、bash、read、bash/read、web/read、`plan-mode-contract`、low-`maxTools` `tool-selection-clipping`、multi-turn `tool-selection-continuation`、`until-done-continuation`，以及 adversarial `tool-result-injection` 场景；可用 `--case plan-mode-contract` 单独复核 `<proposed_plan>` contract，用 `--case tool-selection-clipping` 单独复核 selected-tool clipping telemetry，用 `--case tool-selection-continuation` 或 `--case until-done-continuation` 单独复核 continuation prompt source telemetry，也可用 `--case tool-result-injection` 单独复核工具结果注入边界与 canary confirmation gate。

targeted extension smoke 还覆盖 `fffind-package`、`ffgrep-package`、
`batch-web-fetch-example`、`seq-thinking-status`、`mcp-status`、`subagent-list`
和 `recall-not-found`；PowerShell runner 额外提供 `read-package` 作为
Windows-native cwd-relative path 基线，并覆盖 plan-mode / until-done targeted contract。以上 extension case 默认不进入 full-suite；它们用于按需证明具体
extension tool 的真实 `tool_execution_start` 链路，同时避免 MCP 认证、子代理执行、
observational-memory 真实内容、图片生成或交互 UI 混入常规发布门。
装新 extension 后，Bash runner 可先用低风险 profile：

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk
```

```bash
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh --profile extension-low-risk
```

该 profile 等价于 `mcp-status,subagent-list,recall-not-found`。需要扩展覆盖时再用
`--profile extension-expanded`；默认不传 profile 仍是 10-case full-suite。

provider health 快速预检：

```bash
node ./scripts/pi67-xtalpi-provider-health.mjs
```

provider health 会输出结构化 JSON，并对瞬时 timeout/network/upstream/protocol 抖动做有界重试；`http_429` 只记录为 rate-limit，不做立即重试。
这些错误代码、分类、retryable 语义和 provider-health immediate retry 策略由 `extensions/xtalpi-pi-tools/provider-error-contract.json` 统一定义；contract 内置 `requiredCodes`、`allowedCategories`、`requiredHttpStatus` 和 `classificationSamples` manifest，运行时 provider、preflight 和 validator 共同读取，避免脚本和扩展长期漂移；修改该 contract 后运行 `node ~/.pi/agent/scripts/pi67-validate-xtalpi-provider-error-contract.mjs --self-test` 和 `node ~/.pi/agent/scripts/pi67-validate-xtalpi-provider-error-contract.mjs`。

provider capability 深度探测：

```bash
node ./scripts/pi67-xtalpi-provider-capability-probe.mjs
node ./scripts/pi67-xtalpi-provider-capability-probe.mjs --json-action-runs 5
```

PowerShell：

```powershell
node .\scripts\pi67-xtalpi-provider-capability-probe.mjs
node .\scripts\pi67-xtalpi-provider-capability-probe.mjs --json-action-runs 5
```

该 probe 输出 `xtalpi-pi-tools.provider-capabilities.v1`，分别检查普通 chat、
泛化 `response_format=json_object` prompt、`json_schema strict`、native `tools/tool_choice`、
strict tools、`role=tool` continuation 和本地 JSON action envelope。若结果显示
`json_schema_strict=false` 且 native tools / `role=tool` 不可用，就不要继续把晶泰
当完整 OpenAI tool runtime；正确路径是默认 `recommendedMode=local_json_action_protocol`：
晶泰只生成普通文本中的 JSON action，Pi 本地负责 schema 校验、
selected-tool 白名单、参数校验、repair、错误分类和工具执行。

注意：`json_action_N` 是更贴近日常 runtime 的 targeted probe；即使泛化 `json_object`
prompt 偶发失败，只要 targeted JSON action 连续通过，推荐模式仍应是
`local_json_action_protocol`。

本地 JSON action 是 `xtalpi-pi-tools` 的 canonical 默认协议。它只启用
`response_format: {"type":"json_object"}` 作为语法 hint，不信任上游
schema/native tool 能力；所有 action schema、工具白名单、参数校验、repair 和执行仍在
Pi 本地完成。实现边界集中在 `extensions/xtalpi-pi-tools/json-action-protocol.ts`：
该模块只定义唯一 JSON action 协议、system prompt、`response_format` hint 和
assistant history 包装，不把 OpenAI native tools 委托给晶泰，也不提供旧协议切换入口。

```bash
bash ./scripts/pi67-test-xtalpi-pi-tools.sh
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh --case read
```

PowerShell：

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile quick
```

旧 `<pi_tool_call>` 文本协议不再作为运行时选项。若上游返回这类 markup，provider 会把它归类为协议漂移并进入 JSON action repair。

parser 兼容矩阵离线回归：

```bash
node --no-warnings ./scripts/pi67-fuzz-xtalpi-parser.mjs
```

该 gate 覆盖常见 name/arguments 别名、OpenAI text-native wrapper、
大小写 tool tag、JSON-string arguments 和 fail-closed 场景；PowerShell smoke
也会直接运行 `scripts\pi67-fuzz-xtalpi-parser.mjs`。

provider 默认不再把历史 assistant tool call 序列化为 `previous_pi_tool_call`
记录发给模型；模型只看到后续 `<pi_tool_result>` 里的可观察工具结果。如果 legacy
会话或异常模型输出里仍出现 `previous_pi_tool_call`，provider 会先移除完整历史块，
再把剩余文本交给 final guard。类似“收到，重新发起搜索。”这种没有实际工具调用的
续跑话术会进入有界 repair，而不是直接结束任务或把内部 Pi 协议标记展示给用户。

冒烟 telemetry 汇总：

```bash
bash ./scripts/pi67-xtalpi-pi-tools-debug-summary.sh --latest
```

详细说明见 `docs/xtalpi-pi-tools.md` 和 `docs/troubleshooting.md`。

**xtalpi 外部用户**：完整配置仍会安装 xtalpi-pi-tools provider 模板；如果没有 xtalpi key，可以在 `~/.pi/agent/settings.json` / `models.json` 改用其他 provider。doctor 会把缺 key 或 provider 不匹配报告为 warning/fail。

## 更新

推荐入口：

```bash
pi-67 update
```

只读预览，不拉取也不写文件：

```bash
pi-67 update --check
```

这会同时检查发行版 git 状态和 npm 管理器是否有新版；如果只想离线/本地
检查，使用：

```bash
pi-67 update --check --no-remote
```

如果曾经手动跑过 `pi update --extensions`，或者怀疑 npm 扩展、known patch、
shared skills、xtalpi-pi-tools 本地协议状态没有对齐：

```bash
pi-67 update --repair
```

管理器自身更新是显式动作，不会被普通 update 静默触发：

```bash
pi-67 self-update
```

维护者发布 npm 包前的一键检查：

```bash
pi-67 publish-check
pi-67 publish-check --json
```

`publish-check` 不只检查 npm 包元数据，也会检查 npm scope 可见性和
ownership manifest：保留 runtime config、主题不自动切换、shared skills 默认
不覆盖、external dirty repo 阻断更新、必需 local extensions 存在，以及发行版
基线里不能混入未知 user-managed runtime package。若提示 `@bigking67` scope
不存在，需要先在 npm 创建/认领该用户或组织 scope，或把包名改成维护者拥有的
scope/name。

查看 pi-67 对 packages、extensions、theme、shared skills、external repos 的
所有权边界：

```bash
pi-67 manifest
pi-67 manifest --json
```

永远使用 npm 最新管理器的一次性命令：

```bash
npx -y @bigking67/pi-67@latest update --repair
```

注意：`pi update --extensions` 只属于 Pi 官方上游扩展更新语义，不是 pi-67
完整更新路径。pi-67 的 AGENTS、rules、scripts、xtalpi-pi-tools、shared skills、
doctor/smoke/report、theme preserve 和 external repo 检查都由 `pi-67 update`
编排。

Windows PowerShell：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-update.ps1
# 发布/CI 严格模式；日常不用
.\scripts\pi67-update.ps1 -StrictSharedSkills
```

这个入口是一键日常更新：默认执行 `git pull --ff-only`，保留已有本地 key/config，
只在 `models.json` / `mcp.json` / `auth.json` / `image-gen.json` 缺失时从
`.example` 创建。遇到这次 `xtalpi-compat` -> `xtalpi-pi-tools` 迁移里的已知
tracked 冲突时，它会先备份到 `$env:USERPROFILE\.pi\agent-backups\pre-update-*`，
再只恢复这些已知迁移文件后继续更新；其他 tracked 本地改动仍会停止，避免误覆盖。
更新流程还会在 npm sync 后检查并修补已安装的 `pi-until-done@0.2.2`，给旧版
`pi.sendUserMessage(...)` 调用补上 Pi runtime queue 需要的
`streamingBehavior: "followup"`，避免 `/until-done` 在 agent 正忙时中断。

预览但不写入：

```powershell
.\scripts\pi67-update.ps1 -DryRun
```

只检查当前是否需要更新：

```powershell
.\scripts\pi67-update.ps1 -CheckOnly
```

如果执行策略阻止脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\pi67-update.ps1
```

macOS/Linux：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

更新前或日常巡检想先看当前状态：

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```

PowerShell updater 会：

1. 在 pi-67 仓库中执行 `git pull --ff-only`
2. 保留本地 `models.json` / `mcp.json` / `auth.json` / `image-gen.json`
3. 如果新增本地配置模板，只复制缺失文件，不覆盖已有配置
4. 在备份后把可解析但编码不适合 Pi 启动的本地 JSON 规范化为 UTF-8 without BOM，例如 UTF-16、UTF-8 BOM 或前导 NUL 字节；备份名形如 `models.json.bak-YYYYMMDD-HHMMSS-encoding`
5. 直接在 PowerShell 里做非交互配置迁移，例如把旧 `xtalpi` / `xtalpi-tools` 迁移到 `xtalpi-pi-tools`
6. 如果 `package.json` 和 `~/.pi/agent/npm/package.json` 不一致，自动同步 npm 依赖
7. 检查并按需修补 `pi-until-done` runtime queue 兼容性
8. 运行 `scripts\pi67-smoke.ps1 -Ci` 复核 repo/update contract
9. 覆盖写入 `~/.pi/agent/pi67-report.json`，并默认嵌入 `scripts\pi67-doctor.ps1 -Json` 结果

`pi-67 update` 在 Windows 上会调度这个 PowerShell-native updater；在 macOS/Linux
上会调度 Bash updater。两边都遵守同一条主题策略：更新 theme package 可以，
但不会改 `settings.json.theme`。要改主题必须显式运行：

```bash
pi-67 themes current
pi-67 themes list
pi-67 themes set gruvbox-dark
```

`npm sync` 只在依赖清单变化或显式强制时运行；成功同步后再次更新应显示
`npm package.json already synced` 并跳过。若只是临时想快速拉代码、确认当前依赖
已经可用，可用：

```powershell
.\scripts\pi67-update.ps1 -NoNpm
```

如果只想拉取和 smoke、不写报告：

```powershell
.\scripts\pi67-update.ps1 -NoReport
```

如果想写报告但跳过内嵌 doctor：

```powershell
.\scripts\pi67-update.ps1 -NoDoctor
```

Bash updater 也会运行 doctor 并覆盖写入 `~/.pi/agent/pi67-report.json`。

如果你安装的是旧版，还没有 PowerShell updater，Windows 首次用一次性 bootstrap：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $env:USERPROFILE ".pi\agent-backups\pre-update-$Stamp"
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$KnownPaths = @("settings.json", "extensions/xtalpi-compat/index.ts")
$RestorePaths = @()
foreach ($Path in $KnownPaths) {
  git ls-files --error-unmatch $Path *> $null
  if ($LASTEXITCODE -eq 0) { $RestorePaths += $Path }
}
if ($RestorePaths.Count -gt 0) {
  git diff -- $RestorePaths | Set-Content -Path (Join-Path $BackupDir "local.diff") -Encoding UTF8
  foreach ($Path in $RestorePaths) {
    Copy-Item $Path (Join-Path $BackupDir ($Path -replace "[\\/]", "__")) -ErrorAction SilentlyContinue
  }
  git restore -- $RestorePaths
}
git pull --ff-only
.\scripts\pi67-update.ps1
```

如果你安装的是旧版，还没有 `pi67-update.sh`，macOS/Linux 第一次这样更新：

```bash
cd pi-67
git pull --ff-only
bash scripts/pi67-update.sh
```

预览更新动作但不写入：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --dry-run
```

只检查当前是否需要更新、报告是否过期、npm 是否需要同步，但不执行 pull、doctor 或写报告：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```

Windows 等价只读检查：

```powershell
.\scripts\pi67-update.ps1 -CheckOnly
```

如果本地改过 pi-67 仓库文件，更新脚本会默认停止，避免覆盖你的改动。先 commit/stash，或确认可接受后使用：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --allow-dirty
```

如果不想写报告：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --no-report
```

如果只想更新仓库和依赖、暂时不改本地配置：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --no-configure
```

## 发布维护

pi-67 自身版本以 `VERSION` 为准，`package.json.version` 与
`packages/pi67-cli/package.json.version` 都要保持一致。用户可见变更记录在
`CHANGELOG.md`，发布流程见 `docs/release.md`。

发布或修改安装链路前运行：

Windows PowerShell 入口：

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-doctor.ps1 -Json
.\scripts\pi67-report.ps1 -Operation manual
```

macOS/Linux 和当前 CI 主链路：

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
npm pack --dry-run ./packages/pi67-cli
```

生成发布计划和 release notes 预览：

```bash
bash scripts/pi67-release.sh --dry-run
```

正式创建 tag、push tag 并创建 GitHub Release：

```bash
bash scripts/pi67-release.sh --yes
```

重复控制：

- `pi67-release.sh` 默认不会删除历史版本，也不会创建重复的同版本 tag/release。
- 如果当前 `VERSION` 对应的 `vX.Y.Z` 已存在，脚本会停止，要求先 bump `VERSION`。
- 只有需要重做同一个当前版本时，才使用 `--replace-existing --yes`；它只替换当前 `VERSION` 对应的 tag/release，不清理旧版本。

## 恢复与卸载

安装器会把被覆盖的非 symlink 文件/目录备份到：

```text
~/.pi/agent/backup-YYYYmmdd-HHMMSS
```

从备份恢复：

```bash
bash ~/.pi/agent/scripts/pi67-restore.sh --backup-dir ~/.pi/agent/backup-YYYYmmdd-HHMMSS --dry-run
bash ~/.pi/agent/scripts/pi67-restore.sh --backup-dir ~/.pi/agent/backup-YYYYmmdd-HHMMSS --yes
```

只移除 pi-67 拥有的 symlink，保留本地密钥、MCP、npm、sessions、缓存：

```bash
bash ~/.pi/agent/scripts/pi67-uninstall.sh --dry-run
bash ~/.pi/agent/scripts/pi67-uninstall.sh --yes
```

## 维护原则

- 不提交真实密钥、token、cookie、运行会话、缓存或本地私有状态。
- 修改全局行为时优先更新 `AGENTS.md`；长规则优先落到 `rules/`。
- 修改安装链路后运行 `bash scripts/pi67-smoke.sh`；至少覆盖 `bash -n`、JSON、dry-run、临时 agent-dir 安装和 doctor。
- 修改 skill registry 治理后运行 `bash scripts/pi67-test-skill-governance.sh`；需要核对真实外部 repo 时再运行 `bash scripts/pi67-check-external-skills.sh --repo /path/to/repo`。
- 修改版本、安装器、doctor、configure、report、release、update、restore/uninstall 或 CI 时，同步更新 `VERSION` / `CHANGELOG.md` / `docs/release.md`，并运行 `bash scripts/pi67-release-check.sh`。
- 提交前检查 prompt 模板是否使用 Pi 支持的 `$1` / `$ARGUMENTS` / `${...}`，避免遗留双花括号占位符。

## 贡献

欢迎提 PR 或 Issue。如果你有好的 Pi 配置、Skills、Prompts 或规则治理方案，也欢迎贡献。

## License

MIT
