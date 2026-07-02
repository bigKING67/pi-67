# pi-67 — Pi Coding Agent 配置一站通

[![ci](https://github.com/bigKING67/pi-67/actions/workflows/ci.yml/badge.svg)](https://github.com/bigKING67/pi-67/actions/workflows/ci.yml)

> 我的 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) full-stack 工作台发行版：默认安装完整 Pi 最佳配置，再用 doctor 判断哪些能力已经就绪。

当前发行版版本：`0.10.0`（见 `VERSION` 和 `CHANGELOG.md`）。

## 这是什么

这个仓库把 `~/.pi/agent/` 中可复用、可公开的 Pi 配置整理成可安装版本。推荐长期形态是 `~/.pi/agent` 本身就是这个 Git checkout；它不是 minimal starter，而是完整 Pi 工作流发行包：

- 常驻内核：`AGENTS.md` 只保留硬规则、工具分流、rules 读取契约和交付闭环。
- 长规则外置：`rules/` 存放质量、架构、目录、性能、前端、浏览器、上下文和数据规则，按任务最小读取。
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
| **全局内核** | `AGENTS.md` | Pi 常驻行为规范（v1.4-pi kernel） |
| **Rules** | `rules/` (8 篇) | 质量、架构、结构、性能、前端、浏览器、上下文、数据质量规则 |
| **自定义扩展** | `extensions/` (2 个) | `xtalpi-pi-tools` + `pi-rules-loader` |
| **Shared Skills** | `shared-skills/` (31 个) | 安装到 `~/.agents/skills`，供 Pi/Codex 共用 |
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

需要先检查真实外部仓库和当前 `~/.agents/skills` 是否会冲突时，用只读检查器：

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67
```

## 快速开始

### 前置条件

```bash
# 已安装 pi
npm install -g @earendil-works/pi-coding-agent

# 首次运行 pi 生成 ~/.pi/agent/ 目录
pi --version
```

### 推荐：原地 checkout 到 `~/.pi/agent`

```bash
git clone https://github.com/bigKING67/pi-67.git ~/.pi/agent
cd ~/.pi/agent
./install.sh --agent-dir "$PWD"
```

这种模式下不会把 Pi runtime 资产创建成 symlink；`AGENTS.md`、`rules/`、`shared-skills/`、`scripts/` 等都是当前 checkout 的 tracked assets。安装器会把 `shared-skills/` 复制到 `~/.agents/skills`。`models.json`、`mcp.json`、`auth.json`、`image-gen.json`、`sessions/`、`npm/` 等本机运行态会被 ignored。

长期维护流：

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

## 目录结构

```text
pi-67/
├── README.md
├── VERSION
├── CHANGELOG.md
├── install.sh                      # 一键符号链接安装脚本
├── .gitignore
├── AGENTS.md                       # Pi v1.4-pi 常驻内核
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
│   ├── context-budget.md
│   ├── data-quality.md
│   ├── frontend.md
│   ├── performance.md
│   ├── project-structure.md
│   └── quality.md
├── shared-skills/                  # 31 个共享 Skills，安装到 ~/.agents/skills
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
│   ├── pi67-migrate-skills.sh
│   ├── pi67-release-artifact-smoke.sh
│   ├── pi67-release.sh
│   ├── pi67-release-check.sh
│   ├── pi67-report.sh
│   ├── pi67-restore.sh
│   ├── pi67-skill-audit.sh
│   ├── pi67-smoke.sh
│   ├── pi67-status.sh
│   ├── pi67-sync-external-skills.sh
│   ├── pi67-test-skill-governance.sh
│   ├── pi67-update.sh
│   ├── pi67-uninstall.sh
│   ├── pi67-xtalpi-pi-tools.sh
│   ├── pi67-test-xtalpi-pi-tools.sh
│   ├── pi67-xtalpi-pi-tools-smoke.sh
│   ├── pi67-xtalpi-pi-tools-debug-summary.sh
│   └── pi67-xtalpi-provider-health.mjs
└── templates/
    └── scrapers/
```

## 关于 xtalpi

xtalpi 是晶泰科技内部 API。`models.example.json` 中只保留一个晶泰 provider：`xtalpi-pi-tools`。

`xtalpi-pi-tools` 不再向晶泰发送 OpenAI 原生 `tools` / `tool_choice` / `role=tool`，而是让 Pi 本地解析 `<pi_tool_call>` 文本协议并执行工具。晶泰侧只需要处理普通 chat completion，因此比旧 `xtalpi-tools` 更稳定。

显式启动：

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools.sh
```

静态测试：

```bash
bash ~/.pi/agent/scripts/pi67-test-xtalpi-pi-tools.sh
```

真实冒烟：

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-smoke.sh
```

真实冒烟覆盖 no-tool、bash、read、bash/read、web/read，以及 adversarial `tool-result-injection` 场景；可用 `--case tool-result-injection` 单独复核工具结果注入边界与 canary confirmation gate。

provider health 快速预检：

```bash
node ~/.pi/agent/scripts/pi67-xtalpi-provider-health.mjs
```

provider health 会输出结构化 JSON，并对瞬时 timeout/network/upstream/protocol 抖动做有界重试；`http_429` 只记录为 rate-limit，不做立即重试。
这些错误代码、分类、retryable 语义和 provider-health immediate retry 策略由 `extensions/xtalpi-pi-tools/provider-error-contract.json` 统一定义；contract 内置 `requiredCodes`、`allowedCategories`、`requiredHttpStatus` 和 `classificationSamples` manifest，运行时 provider、preflight 和 validator 共同读取，避免脚本和扩展长期漂移；修改该 contract 后运行 `node ~/.pi/agent/scripts/pi67-validate-xtalpi-provider-error-contract.mjs --self-test` 和 `node ~/.pi/agent/scripts/pi67-validate-xtalpi-provider-error-contract.mjs`。

冒烟 telemetry 汇总：

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-debug-summary.sh --latest
```

详细说明见 `docs/xtalpi-pi-tools.md` 和 `docs/troubleshooting.md`。

**xtalpi 外部用户**：完整配置仍会安装 xtalpi-pi-tools provider 模板；如果没有 xtalpi key，可以在 `~/.pi/agent/settings.json` / `models.json` 改用其他 provider。doctor 会把缺 key 或 provider 不匹配报告为 warning/fail。

## 更新

如果已经安装过较新的 pi-67，直接运行：

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

更新前或日常巡检想先看当前状态：

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```

它会：

1. 在 pi-67 仓库中执行 `git pull --ff-only`
2. 保留本地 `models.json` / `mcp.json` / `auth.json` / `image-gen.json`
3. 如果新增本地配置模板，只复制缺失文件，不覆盖已有配置
4. 自动运行 `pi67-configure.sh --no-prompt --no-doctor` 做非交互配置迁移，例如把旧 `xtalpi` / `xtalpi-tools` 迁移到 `xtalpi-pi-tools`
5. 如果 `package.json` 和 `~/.pi/agent/npm/package.json` 不一致，自动同步 npm 依赖
6. 运行 doctor 复核 readiness
7. 覆盖写入 `~/.pi/agent/pi67-report.json`

如果你安装的是旧版，还没有 `pi67-update.sh`，第一次这样更新：

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

pi-67 自身版本以 `VERSION` 为准，`package.json.version` 与它保持一致。用户可见变更记录在 `CHANGELOG.md`，发布流程见 `docs/release.md`。

发布或修改安装链路前运行：

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
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
