# pi-67 — 面向团队的 Pi 一键工作台发行版

[![ci](https://github.com/bigKING67/pi-67/actions/workflows/ci.yml/badge.svg)](https://github.com/bigKING67/pi-67/actions/workflows/ci.yml)

> 让 Windows 和 macOS 用户用尽可能少的步骤，获得公司统一、持续升级、可诊断、可回滚的 Pi 工作台。`pi` 始终是实际运行入口；`pi-67` 负责把 Pi 所需的配置、扩展、Skills、规则、脚本和公司默认 provider 封装成一键发行版。

当前发行版版本：`0.14.2`（见 `VERSION` 和 `CHANGELOG.md`）。

## 项目定位

**一句话定位：pi-67 是面向团队和小白用户的 Pi 工作台发行版与配置管理器，不是 Pi 运行时。**

底座始终是上游
[@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)，
用户最终通过官方 `pi` 命令启动界面、连接模型并执行工具。pi-67 解决的是另一层问题：
把团队反复需要的安装、配置、扩展、Skills、provider、规则、更新、诊断和验收整理成
可重复的一键流程，让没有工程背景的同事也能在 Windows 或 macOS 上稳定使用 Pi。

### 名称由来

`pi-67` 中的 **67** 来自项目维护者 67。项目最初由 67 基于自己长期使用 Pi
形成的配置、习惯、extensions、Skills 和工作流整理而成；随着 67 负责公司 Agent
工具的开发、配置、推广和使用，它逐步演进为团队可复用、对小白友好的一键 Pi
工作台发行版。

因此，pi-67 不是一个没有产品判断的通用空壳 starter，也不是只适用于某一台电脑的
私人配置备份；它是 67 基于真实 Pi 使用经验和公司 Agent 工具实践持续策展、验证并
面向 Windows/macOS 团队用户发布的工作台。

### 为什么需要 pi-67

如果每位同事都手工安装和维护 Pi，容易出现 provider 名称、扩展版本、Skills 目录、
MCP 路径、Windows/macOS 命令和排障口径不一致。pi-67 把这些公共部分产品化：

- **小白一键可用**：尽量用少量稳定命令完成安装、配置、更新和验收。
- **跨平台一致**：同一套发行内容同时支持 Windows 笔记本和 macOS。
- **公司默认能力开箱即用**：统一提供 `xtalpi-pi-tools` 配置和协议适配；公司同事使用同一 provider，只有个人 API key 不同，同时不影响 upstream Pi 使用其他 provider。
- **持续升级**：后续新增或升级 extensions、Skills、rules、prompts、MCP 模板和诊断能力，都通过 pi-67 统一发布。
- **保留个人状态**：更新时保护每个人自己的 key、认证、模型选择、主题、MCP 路径、会话和本地扩展。
- **可诊断、可回滚**：通过 doctor、smoke、版本合同、备份和恢复降低跨机器维护成本。

### 职责边界

| 层级 | 所有者 | 职责 | 主要入口 |
|------|--------|------|----------|
| **Pi 运行时** | 上游 `@earendil-works/pi-coding-agent` | 启动界面、连接模型、加载 extension、执行工具和任务 | `pi` |
| **pi-67 npm manager** | `@bigking67/pi-67` | 安装、更新、修复、doctor、smoke、备份和发行版治理 | `pi-67` |
| **Pi 工作台发行版** | 本仓库 / `~/.pi/agent` | `AGENTS.md`、rules、extensions、scripts、prompts、模板和默认配置 | `pi-67 install/update` |
| **共享 Skills** | pi-67 发布源 / `~/.agents/skills` | 为 Pi、Codex 等 agent 提供团队复用能力 | `pi-67 skills/external` |
| **个人运行态** | upstream Pi + 每位用户自己的电脑 | `/login` 认证、`/model` 选择、下次启动恢复、MCP 本地路径、主题和会话 | Pi 原生状态与 ignored 本地文件 |

### 不可破坏的架构边界

- `pi` 是唯一标准的日常运行入口；pi-67 不 fork、不重写、不替代 upstream Pi。
- `pi-67` 是安装和治理工具，不应演变成一套平行的聊天运行时或强制启动器。
- `pi-67 launch` 若保留，只能作为 Windows 当前终端 PATH 未刷新时的可选兼容工具；它不是日常主入口，也不能作为判断 Pi 是否可用的唯一标准。
- 验收必须优先验证真实 `pi`、真实工作台配置和真实工具链，不能用临时 wrapper 或 mock 代替端到端结论。
- 公司推荐使用 `xtalpi-pi-tools`，pi-67 统一发布其 provider 结构、base URL 规则和工具协议；每位用户只在本机填写自己的 key，仓库永不保存真实凭据。
- **没有配置任何 API key 时也必须能启动 `pi`。** 缺少 key 只影响对应模型请求，不得阻止 Pi 进入界面。
- `/login`、`/model`、认证保存、模型选择及下次启动恢复全部属于 upstream Pi 的原生持久化合同；pi-67 不代理、不重写、不自动切换这些状态。
- `xtalpi-pi-tools` 不是 `pi` 的硬依赖。DeepSeek、Anthropic、OpenAI、Google 等其他 provider 继续按 upstream Pi 的原生流程使用；pi-67 不在 `models.json` 重复声明内置 provider。
- Windows 和 macOS 是同等支持的平台；新增 extension、Skill 或配置能力时必须考虑两端安装、更新和排障体验。
- 后续扩展 pi-67 时，优先增加可复用的配置和能力资产，不把 upstream Pi 已经负责的运行时职责搬进本仓库。

### 用户生命周期

```text
Windows 纯新机先在管理员 Windows PowerShell 中确保 WinGet 可用
  -> 安装 Windows Terminal
  -> 手动安装 Git / fnm / Node.js 24 LTS
  -> 安装 upstream Pi
  -> 轻量 bootstrap 安装 pi-67 manager 并部署 ~/.pi/agent
  -> 日常直接运行 pi
  -> 首次需要模型时在 Pi 内执行 /login 和 /model
  -> upstream Pi 保存选择，下次启动自动恢复
  -> 后续由 pi-67 统一更新和验收工作台能力
```

对应命令关系：

```bash
# 底座：独立安装 upstream Pi，日常使用 pi
npm install -g @earendil-works/pi-coding-agent@latest
pi --version

# 工作台：安装 manager 并部署团队发行版
npm install -g @bigking67/pi-67@latest
pi-67 install --repair --yes

# 日常启动真实 Pi
pi

# 只更新 upstream Pi runtime
npm install -g @earendil-works/pi-coding-agent@latest
pi --version

# manager 落后时先更新 manager
pi-67 self-update

# 日常更新 pi-67 工作区与托管能力
pi-67 update
pi-67 doctor

# 进入 Pi 后按需执行
/login
/model

# 可选：提前配置公司 xtalpi key；不是启动 Pi 的前置步骤
pi-67 xtalpi configure --verify

# 可选：首次启用当前系统用户的跨项目 Hy-Memory
pi-67 memory init
pi-67 memory doctor --deep
```

## Windows 纯新电脑：从系统 PowerShell 开始

Windows 系统前置软件改为按文档手动安装。第一步是在开始菜单中以管理员方式打开
系统自带 Windows PowerShell，先确保 WinGet 可用，再通过命令行安装 Windows
Terminal：

```powershell
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe
}
winget --version

# winget 确认可用后再安装 Terminal
winget install --id Microsoft.WindowsTerminal -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id Microsoft.PowerShell -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id zufuliu.notepad4 -e --source winget --accept-package-agreements --accept-source-agreements
```

然后以管理员身份打开 Notepad4，在 **设置 -> 高级设置 -> 系统集成** 中启用资源
管理器右键菜单并通过注册表替换 Windows 记事本。完成后安装 Git：

```powershell
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
```

确认
`where.exe git`、`git --version` 以及 User/Machine 持久 PATH 均正确，再把 Windows
Terminal 默认 profile 设置为刚安装的 **PowerShell 7**，并开启该 profile 的管理员
启动。随后在 PowerShell 7 中手动安装 fnm、Node.js 24 LTS（最低
`>=22.19.0`）和真实 upstream Pi。最后下载发布版 `pi67-bootstrap.ps1`；该脚本现在
只安装/更新 `@bigking67/pi-67` manager 和 `~/.pi/agent` 工作区，不请求 UAC，
不再安装或修改 Windows 工作站前置项。完整的逐步命令、SHA-256 校验、失败恢复和
验收见 [`docs/windows-fresh-install.md`](docs/windows-fresh-install.md)。

Windows Terminal 和 PowerShell 7 安装后还必须完成团队默认合同：默认 profile 选择
**PowerShell**，开启该 PowerShell 7 profile 的管理员启动，再按完整指南一次性注册
固定的最高权限计划任务，并将其快捷方式作为日常入口。从该入口打开时默认就是
PowerShell 7，管理员状态为 `True`，且不会每次重复弹 UAC；原始 Terminal 图标仍会
按 Windows 机制显示 UAC。

## 工作台组成

这个仓库把 `~/.pi/agent/` 中可复用、可公开的 Pi 配置整理成可安装版本。推荐长期形态是 `~/.pi/agent` 本身就是这个 Git checkout；它不是 minimal starter，而是完整 Pi 工作流发行包：

- 常驻内核：`AGENTS.md` 只保留硬规则、工具分流、rules 读取契约和交付闭环。
- 长规则外置：`rules/` 存放质量、架构、目录、性能、前端、浏览器、上下文、数据、电商增长、投资研究和 pi-67 产品边界，按任务最小读取。
- 扩展补强：`extensions/pi-rules-loader/` 给 Pi 注入紧凑 rules 索引，并按 frontmatter `triggers` 确定性加载本轮命中的最小规则集；`extensions/xtalpi-pi-tools/` 让 Pi 本地托管 xtalpi 工具协议；`extensions/pi-vision-bridge/` 把图片/截图任务桥接到本地多模态 provider；`extensions/pi-hy-memory/` 提供当前系统用户跨项目共享的私有长期记忆。
- 生产力资产：Skills、Prompts、Docs、Templates 和脚本保持仓库化，便于审计、同步和回滚。

仓库不会提交真实 `auth.json`、`models.json`、`mcp.json`、`image-gen.json`、会话、缓存或运行历史；只提供 `.example` 模板。

默认安装是 **full install**：所有最佳配置都会部署。缺 API key、本地 MCP repo 或外部二进制时，不裁剪配置，而是由 `scripts/pi67-doctor.sh` 报告 readiness warning。安装器支持两种模式：

- **in-place repo**：`REPO_ROOT == ~/.pi/agent`，可发布资产是 Git tracked 文件，本机配置/缓存/会话由 `.gitignore` 排除。
- **linked install**：外部 checkout 通过 symlink 映射到 `~/.pi/agent`，保留给兼容旧安装。

## 包含内容

| 类别 | 内容 | 说明 |
|------|------|------|
| **核心配置模板** | `settings.example.json` | 发行版默认 provider/model、Pi package 列表；首次安装复制为 ignored 的本机 `settings.json` |
| **模型配置** | `models.example.json` | xtalpi-pi-tools / codex provider 模板 |
| **MCP** | `mcp.example.json` | browser67 tmwd_browser、js-reverse 模板 |
| **全局内核** | `AGENTS.md` | Pi 常驻行为规范（v1.8-pi kernel） |
| **Rules** | `rules/` (11 篇) | 质量、架构、结构、性能、前端、浏览器、上下文、数据质量、电商增长、投资研究、pi-67 产品边界规则 |
| **自定义扩展** | `extensions/` (4 个) | `xtalpi-pi-tools` + `pi-rules-loader` + `pi-vision-bridge` + `pi-hy-memory` |
| **Shared Skills** | `shared-skills/` | 安装到 `~/.agents/skills`，供 Pi/Codex 共用 |
| **Skill 治理** | `docs/skill-governance.md` | skill 公开发行 / 个人 overlay / 过期治理规则 |
| **文档** | `docs/` | Windows 新机、全量安装、doctor/report/status schema、排障、发布流程、MCP 优化、爬虫指南、工具速查、xtalpi 配置 |
| **Prompts** | `prompts/` (5 个) | debug、deliver、frontend-kickoff、review、scoped-commit |
| **脚本** | `scripts/` | Windows pi-67 manager/workspace bootstrap、configure、doctor、report、status、prompt governance、skill-audit、skill migration/sync/check、release artifact smoke、release、release-check、smoke、update、restore、uninstall、xtalpi-pi-tools 启动、测试和冒烟测试 |
| **模板** | `templates/scrapers/` | 采集/合并/轮询相关脚本模板 |

## Hy-Memory 长期记忆

pi-67 `0.13.0` 新增自己维护的 `pi-hy-memory` 第一方适配层。它使用固定并
校验过的腾讯 Hy-Memory 官方 Python SDK，但不是腾讯官方 Pi 插件；员工仍然
直接运行 upstream `pi`，不会出现第二套聊天 runtime。

首次启用：

```bash
pi-67 memory init
pi-67 memory doctor --deep
pi
```

每个操作系统用户的数据、凭据、Python 3.11 runtime、outbox 和日志保存在
`~/.hy-memory/pi67`，跨该用户所有 Pi 项目共享，不写进 Git checkout。pi-67
不会迁移、修改或删除用户自行安装的第三方记忆 MCP、EverOS 或
`pi-observational-memory`，但也不把它们作为发行版默认能力。持久化是本地的，
但抽取/整理会请求 DeepSeek，embedding 会请求 SiliconFlow。

模型职责：

- `deepseek-v4-flash` 是 Hy-Memory 用于抽取、整理和 digest 的普通 LLM；
- `BAAI/bge-m3` 把文本变成向量，本地 Chroma 再完成相似度召回；
- BGE-M3 请求不发送 `dimensions`，本地向量库固定使用实际的 1024 维。

完整的员工初始化、数据/网络边界、Pi 内 `/memory`、`hy_memory_*` 工具、
暂停/恢复、删除、升级、dead-letter 和维护者 SDK 升级流程见
[`docs/hy-memory.md`](docs/hy-memory.md)。

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
- browser67 MCP：在本机 ignored `mcp.json` 里配置源码路径；默认模板用
  `cwd=~/.agents/packages/browser67` 加相对 `args`，也可用
  `pi67-configure --tmwd-repo` 改到任意 checkout；该 helper 会写成本机
  absolute `cwd` + relative `args`。不要在 MCP `command` / `args` 里写
  `$HOME/...`；`pi-mcp-adapter` 不会 shell-expand 这些字段。

旧安装如果 doctor 或 shared-skill inventory 已经发现 duplicate / conflict /
skipped / `auto (user)` 一类 Skill 来源冲突，先用迁移工具预览；它默认
dry-run、只复制缺失 skill、
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

`commerce-growth-os` 已升级为 Manifest 驱动的 8-Skill Pack，不再是
root-level 单 Skill 仓库。直接从独立仓库安装时使用其自己的事务化 Installer：

```bash
bash /path/to/commerce-growth-os/scripts/install.sh \
  --install-root ~/.agents/skills \
  --dry-run

bash /path/to/commerce-growth-os/scripts/install.sh \
  --install-root ~/.agents/skills
```

维护 pi-67 vendored 发行副本时，用 Pack Helper 从上游 Manifest 构建并
事务化刷新 8 个 `shared-skills/<skill>`；普通用户不执行这个维护命令：

```bash
bash ~/.pi/agent/scripts/pi67-sync-commerce-skill-pack.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-commerce-skill-pack.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

维护 Helper 只接受干净的上游 Git checkout，并同时更新
`shared-skill-packs.lock.json`。Lock 固定上游完整 Commit、Manifest SHA-256、
整包 SHA-256 和每个 Skill 的 SHA-256，避免同一个版本号对应不同内容。

普通用户在 `pi-67 update` 后检查或显式升级整套 Pack：

```bash
pi-67 skills packs
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
```

pi-67 还内置 `ai-berkshire-investment-suite`，将 AI Berkshire 的 21 个价值投资
Skill、所需 Python 工具、MIT License 和上游 provenance 作为共享 Pi/Codex Pack
发布。投资任务按 `rules/investment.md` 路由；普通用户显式预览或同步整套 Pack：

```bash
pi-67 skills sync-pack ai-berkshire-investment-suite --dry-run
pi-67 skills sync-pack ai-berkshire-investment-suite --yes
```

维护者使用 `scripts/pi67-sync-ai-berkshire-skill-pack.sh` 从干净的上游 checkout
生成 Pack；同步器不执行上游脚本。每个 pi-67 版本锁定一个可复现 Commit，
`.github/workflows/ai-berkshire-refresh.yml` 每日检查 `main`，有更新时只创建或
更新 PR，不自动合并、npm publish、打 tag 或创建 Release。

默认更新只复制缺失 Skill，并保留内容不同的 active Skill。`sync-pack
--yes` 把 Git 跟踪且 provenance-locked 的 Pack 事务部署到 `~/.agents/skills`：
`staged/previous` 只存在于一次同步事务中，成功或失败后立即删除，不创建持久 Skill
内容备份。写入式同步由 `~/.pi/pi67/locks/skills-deploy.lock` 串行化，避免两个
Pi/Codex 或更新进程同时改写同一 Active Skill Root；Dry-run 不创建锁。若需回滚，
维护者在 `commerce-growth-os` Git 仓库选择或 revert 目标 Commit/Tag，重新生成 Pack
provenance 后再次同步；普通机器使用对应的固定版本重新部署。Git 保存版本历史，
Active Skill 始终是可重建的安装产物。
`pi-67 status`、`pi-67 update --check`、Bash/PowerShell Doctor 和
`pi67-report.json` 会自动暴露同一份
`pi67-shared-skill-packs-status/v1` 状态；发现差异时只建议先运行
`skills packs` 和 `sync-pack ... --dry-run`，不会自动升级到写入式 `--yes`。
Registry 或 provenance Lock 无效属于阻断错误；Active Skill 与可信 vendored
基线不同仍按用户修改处理，默认警告、strict 模式失败。

需要先检查真实外部仓库和当前 `~/.agents/skills` 是否会冲突时，用只读检查器：

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67
```

### browser67 是显式可选能力

`pi-67 install` 默认不安装 browser67。第一次启用时，统一使用
`external install` 作为用户入口；它负责 clone managed checkout，并继续完成
依赖、Chrome/Edge 扩展文件、active skills 和 MCP 配置准备：

```bash
pi-67 external install browser67 --dry-run
pi-67 external install browser67
```

安装会执行 `npm ci`、browser67 extension setup、`browser67` / `js-reverse`
active skill 同步，并把 `tmwd_browser` 与 `js-reverse` MCP 指向 managed
checkout。已完整就绪时重复执行 install 会跳过昂贵的 runtime setup。
`--start-hub` 是首次安装时的显式可选项：

```bash
pi-67 external install browser67 --start-hub
```

Chrome/Edge 的开发者模式、加载 unpacked extension、系统权限和重新启动 Pi
仍然是人工步骤。install 会打印实际 extension 目录和剩余步骤。完成后分层验收：

```bash
pi-67 external doctor browser67
pi-67 external doctor browser67 --deep
```

普通 doctor 检查 checkout、依赖、extension、active skills 和 MCP 配置；
`--deep` 还会运行 browser67 live doctor，验证本机 Hub/extension 连接。
使用任意其他有效 browser67 checkout 的 absolute MCP entrypoint 仍受支持，
不会被错误标成损坏；update 触发的自动 runtime setup 也会保留两项 MCP 已共同
指向的有效 alternate checkout。如需主动把 MCP 重建到 managed checkout，显式执行
`external setup browser67`。

日常更新只需一个高层命令。它会以 `git pull --ff-only` 安全更新干净的
checkout；有新 Commit，或 deterministic readiness 不完整时，自动重新运行
必要的 runtime setup。仓库缺失时 update 不会暗中变成 install：

```bash
pi-67 external update browser67
pi-67 external doctor browser67 --deep
```

`external setup browser67` 只用于对已安装 checkout 显式重建依赖、extension、
active skills 和 MCP 配置；它不再承担首次 clone。外部仓库存在本地修改时，
update 继续 fail closed，不 reset、clean 或覆盖工作树。

## 快速开始

### Windows 纯新电脑（推荐）

从管理员 Windows PowerShell 确保 WinGet 可用，再安装 Windows Terminal：

```powershell
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe
}
winget --version
winget install --id Microsoft.WindowsTerminal -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id Microsoft.PowerShell -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id zufuliu.notepad4 -e --source winget --accept-package-agreements --accept-source-agreements
```

只有找不到 `winget` 时才需要执行 App Installer 注册命令；如果 App Installer 缺失、
Store 不可用或注册仍失败，按
[`docs/windows-fresh-install.md`](docs/windows-fresh-install.md) 使用
`Microsoft.WinGet.Client` / `Repair-WinGetPackageManager -AllUsers` 官方兜底。

先完成 Notepad4 的资源管理器右键菜单和系统记事本替换，随后安装 Git：

```powershell
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
```

确认 Git 已写入持久 PATH；然后把默认 profile 改为 PowerShell 7、开启管理员启动并
创建固定的免重复 UAC
入口。随后在新开的 PowerShell 7 中安装并初始化 fnm：

```powershell
winget install --id Schniz.fnm -e --source winget
# 关闭全部 Windows Terminal 窗口，然后重新打开 PowerShell 7
$ProfileDir = Split-Path -Parent $PROFILE
New-Item -Path $ProfileDir -ItemType Directory -Force | Out-Null
New-Item -Path $PROFILE -ItemType File -Force | Out-Null
notepad $PROFILE
```

在 Notepad4 中向 `$PROFILE` 添加下面一行并保存：

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

回到终端加载 profile，安装并选择 Node.js 24 LTS，再设置 npm 镜像源：

```powershell
. $PROFILE
fnm install lts/krypton
fnm default lts/krypton
fnm use lts/krypton
node --version
npm --version
npm config set registry https://registry.npmmirror.com
npm config get registry
```

最终 `npm config get registry` 应输出 `https://registry.npmmirror.com/`。然后安装 upstream
Pi。全部前置命令验证通过后，再运行发布版 `pi67-bootstrap.ps1 -Mode Auto` 安装
pi-67 manager/workspace。bootstrap 不再安装系统或 runtime 前置项。完整说明见
[`docs/windows-fresh-install.md`](docs/windows-fresh-install.md)。

如需截图所示的分段彩色提示符，可以在完成 Node/npm 设置后可选安装 Oh My Posh：

```powershell
winget install JanDeDobbeleer.OhMyPosh --source winget --scope user --force
notepad $PROFILE
```

在 `$PROFILE` 最后一行添加 `oh-my-posh init pwsh | Invoke-Expression`，保存后运行
`. $PROFILE`。只有普通初始化被 ExecutionPolicy 阻止时，才改用
`oh-my-posh init pwsh --eval | Invoke-Expression`；该 fallback 会降低 Shell 启动速度。
字体主推荐使用包含 Nerd Font 图标和中日韩字形的 `Maple Mono NF CN`；按完整指南从
官方 release 下载 `MapleMono-NF-CN.zip` 与 `.sha256`、校验后安装，并在 Windows
Terminal 中选择 `Maple Mono NF CN`。Meslo 只作为 GitHub 下载失败时的兼容 fallback。
主题预览见 <https://ohmyposh.dev/docs/themes>，字体说明见
<https://github.com/subframe7536/maple-font/blob/variable/README_CN.md>。Oh My Posh 和
字体都是可选外观层，不属于 bootstrap 或 workstation acceptance 的硬依赖。

安装 PowerShell 7、Notepad4 和 Git，并完成 Notepad4 系统集成与 Git 持久 PATH
验收后，进入 Terminal 设置把默认 profile 设为 **PowerShell**，
开启 **Automatically run as Administrator**，再按完整指南创建并固定
`Windows Terminal (Administrator)` 免重复 UAC 入口，然后继续安装 fnm。

### 已有 Git/Node/Pi 的快速路径

Windows 用户默认使用 PowerShell；macOS/Linux 用户继续使用 Bash 示例。Windows
前置条件是 `git --version`、`node --version`、`npm --version` 和 `pi --version`
全部成功。

pi-67 会把完整发行版 clone 到 `~/.pi/agent`，因此本机必须能运行 `git`。
`0.10.19+` 会自动查找常见 Git for Windows 安装位置；如果 Git 已安装但
PowerShell 当前窗口没刷新 PATH，`pi-67 install --repair --yes` 会先为当前
pi-67 进程补上 Git 路径，并把 Git 目录写入 Windows **User PATH**，后续新开的
PowerShell 也能直接运行 `git --version`。写入后还会广播 Windows 环境变更；
如果已经打开的旧 PowerShell 仍看不到新 PATH，关闭并重新打开即可。真正没安装
Git 时，再按下面命令安装：

```powershell
git --version
```

Windows 如果提示找不到 `git`，先安装 Git for Windows，关闭并重新打开 PowerShell：

```powershell
winget install --id Git.Git -e --source winget
git --version
```

如果 `winget` 提示 Git 已安装但 `git --version` 仍找不到命令，先关闭并重新打开
Windows Terminal；不要在前置命令仍失败时继续安装 pi-67。

前置项正常后可以直接运行轻量 bootstrap：

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto
```

也可以手动安装 manager 并部署工作区。日常启动始终使用 `pi`；`pi-67 launch`
仅保留为旧终端尚未刷新 PATH 时的临时兼容工具，不是标准入口。

```bash
# 安装真正的 Pi 运行时
npm install -g @earendil-works/pi-coding-agent

# 先用 pi-67 部署团队工作台，再开始日常使用 pi。
# upstream Pi 首次运行可能安装 git-based packages，因此 Windows 需要先确保 Git PATH 已生效。
```

PowerShell 等价命令：

```powershell
npm install -g @earendil-works/pi-coding-agent
npm install -g @bigking67/pi-67@latest
pi-67 install --repair --yes
pi-67 doctor
pi --version
pi
```

### 首选：npm 管理器 `pi-67`

面向普通用户和长期维护，推荐先安装 pi-67 的 npm 管理器。它只提供
`pi-67` / `pi67` 命令，不覆盖 Pi 官方 `pi` 命令：

```bash
npm install -g @bigking67/pi-67
pi-67 install --repair --yes
pi-67 update
pi-67 doctor
pi-67 smoke --quick
pi
```

Windows PowerShell 使用同一套命令：

```powershell
npm install -g @bigking67/pi-67
pi-67 install --repair --yes
pi-67 update
pi-67 doctor
pi-67 smoke --quick
pi
```

首次进入 Pi 后，使用 upstream Pi 自己的命令完成认证和模型选择：

```text
/login
/model
```

upstream Pi 负责保存认证和当前模型；关闭后再次运行 `pi`，会恢复上一次选择。
pi-67 不在安装或更新时自动切换 provider/model，也不重写这套持久化状态。

公司用户如果希望在进入 Pi 前提前写入 `xtalpi-pi-tools` key，可以选择运行：

```powershell
pi-67 xtalpi configure --verify
```

这是晶泰 provider 的便利工具，不是 `pi` 的启动前置条件；DeepSeek、Anthropic、
OpenAI、Google 等其他 provider 继续直接使用 Pi 内置的 `/login` 和 `/model`。

Windows 已有 pi-67 checkout 时，更新和完整验收不需要再手工逐条执行。直接运行：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pi67-windows-acceptance.ps1
```

这个一键入口会先执行 `pi-67 self-update` 更新 npm manager，再执行智能默认入口
`pi-67 update` 更新本地发行版，随后验证版本/配置、doctor、repo
smoke、真实 Pi 运行时、零 key 的 `xtalpi-pi-tools` extension 加载，以及当前模型请求
readiness。当前选择是已配置的 `xtalpi-pi-tools` 时，会继续运行 health/capability 与
`read-package + read-enoent-recovery` 真实工具链；其他 provider 或未配置 key 时，
这些晶泰专项阶段显示 `SKIP`，但 Pi 启动验收仍然可以通过。完整长输出写入 repo 外临时目录；成功时终端
只给紧凑结果，失败时会额外打印失败阶段最后最多 40 行输出、完整日志路径、恢复建议和
summary 路径。`SKIP` 代表专项检查不适用，不是启动失败。
只验当前版本、不更新时才加 `-SkipUpdate`，输出会明确标注这两个更新阶段
是由该参数主动跳过，并不代表更新失败。

Windows 新机完成 `pi-67 install --repair --yes` 后，建议关闭并重新打开
PowerShell，再运行 `git --version`、`pi --version` 和 `pi`。upstream Pi 首次运行时
可能安装 `git:github.com/justhil/pi-image-gen` 这类 Git 包；如果旧 PowerShell 还没有
继承 Git for Windows 的 PATH，先重开终端。`pi-67 launch` 只用于无法立即重开终端时
给单次子进程临时补 PATH，不应写进团队日常使用流程。

如果你看到 `agent dir exists but is not a git checkout`，说明
`~/.pi/agent` 已经被 Pi 或手工安装创建成普通文件夹。`pi-67 install` 不会静默覆盖它；
使用 `pi-67 install --repair --yes` 会先把旧目录移动到
`~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent`，再重新 clone pi-67。

长期边界：

- `pi` 是 upstream Pi 的标准日常入口；pi-67 负责准备和维护工作台，不替代 `pi`。
- upstream Pi runtime 只通过独立命令 `npm install -g
  @earendil-works/pi-coding-agent@latest` 安装或更新；完成后用 `pi --version`
  验证。
- `pi update --extensions` 只属于 upstream Pi 的 user-managed extensions，
  不负责 pi-67-managed extensions。
- `pi-67 update` 只更新 pi-67 工作区、托管 extensions、Skills、rules、
  prompts、templates、MCP/provider 模板、配置迁移与依赖。pi-67 不会安装或更新 upstream Pi。
- `npm install -g @bigking67/pi-67@latest` / `pi-67 self-update` 是 npm
  manager 自身更新命令；如果 manager 落后，先更新 manager，再跑
  `pi-67 update`。
- 如果误跑了 `pi update --extensions`，再运行 `pi-67 update --repair` 重新对齐 pi-67 管理状态。
- 如果 Pi 启动时提示 `Package Updates Available`，先运行
  `pi-67 update --check` 或 `pi-67 extensions doctor`。pi-67 会区分：
  本地 `npm/node_modules` 没同步，还是 pi-67 发行版还没吸收某个上游
  npm 扩展最新版；不要默认让小白直接跑 `pi update --extensions`。

`settings.json` 从 `0.12.0` 起是 ignored 的本机运行态，仓库只跟踪
`settings.example.json`。首次安装仅在本机设置缺失时复制模板；后续更新不会把模板
变化强行覆盖到个人设置。`pi-67 update` 默认不覆盖用户本地选择：现有 `settings.json`、`models.json`、
`auth.json`、`mcp.json`、`image-gen.json`、用户添加的 packages、全局 skills 和
`settings.json` 里的 `theme` 选择都会保留；legacy `settings.json.theme` 若存在也
按运行态文件备份/恢复。真实更新前 npm manager 会在 repo 外创建 update
lock、生成 update plan，并拦截非运行态 dirty worktree：

```text
~/.pi/pi67/locks/update.lock
```

运行态快照由 Bash / PowerShell updater 在确实需要临时清理 dirty
`settings.json` 等 preserved runtime 文件时创建。updater 会先 `git fetch`，
比较 `HEAD..FETCH_HEAD` 的变更路径；只有 incoming 更新会触碰这些 dirty
运行态文件时，才会创建快照、临时清理、fast-forward、再恢复：

```text
~/.pi/pi67/backups/pre-update-runtime-*
```

`--help`、被 dirty plan 拦截的 update、远端已是当前 commit 的 update、incoming
更新未触碰 dirty 运行态文件的 update，以及 npm manager 编排层都不会额外写
runtime backup。若确实需要备份，但 preserved runtime 文件和已有快照完全一致，
updater 会复用已有快照，不再每次生成新的时间戳目录。

备份可直接用管理器查看和恢复；真实恢复前会再写一份 pre-restore 备份，避免
把当前运行态覆盖到无法回退：

```bash
pi-67 backups list
pi-67 backups list --include-legacy
pi-67 backups inspect <backup-id-or-path>
pi-67 backups inspect <pre-update-id> --legacy
pi-67 backups restore --from <backup-id-or-path> --dry-run
pi-67 backups restore --from <backup-id-or-path> --yes
pi-67 backups prune --keep-last 10 --dry-run
pi-67 backups archive --keep-last 10 --older-than 30d --dry-run
```

`~/.pi/agent-backups/pre-update-*` 是早期/兼容 PowerShell 更新器在处理
known migration conflict 文件时写的历史安全快照；当前 updater 不再写这个目录。
当前主路径是 `~/.pi/pi67/backups/`。需要解释旧目录时只读查看：
`pi-67 backups list --include-legacy`。

主题只在显式执行下面命令时改变，且显式切主题前也会先写运行态备份：

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

如果本机安装的 npm 管理器本身落后，`pi-67 update --check` 会提示更新；
这个 latest 检查直接访问 npm registry HTTP API，不再依赖本机
`npm` / `npm.cmd` shim。显式 npm 操作（例如 `pi-67 self-update`）在
Windows 上还会追加 `cmd.exe /d /s /c npm.cmd ...` 兜底。
`0.10.25+` 开始，真实 `pi-67 update` / `pi-67 update --repair` 会在
manager 落后时先阻断并提示更新 manager，避免旧 manager 继续执行旧的修复逻辑。
显式更新管理器用：

```bash
pi-67 self-update
```

如果想完全绕过本机旧管理器，直接用 npm 最新版执行一次正常更新：

```bash
npx -y @bigking67/pi-67@latest update
```

`npm install -g @bigking67/pi-67` 是日常推荐安装方式；`npx -y
@bigking67/pi-67@latest ...` 是零全局安装的一次性最新版执行方式，适合首次验证、
临时修复或怀疑本机全局管理器落后时使用。二者最终管理的是同一个
`~/.pi/agent` 发行版 checkout。

管理器的轻量状态文件写到 repo 外：

```text
~/.pi/pi67/state.json
```

它只记录版本、commit、theme、provider/model、本地路径，以及
`settings.json.lastChangelogVersion` 这类 Pi runtime UI marker；不保存 API key。

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

如果只想快速 doctor 而不等待 upstream `pi list` package probe，用：

```bash
pi-67 doctor --no-pi-list
pi-67 doctor --pi-list-timeout-seconds 60
```

只想快速看当前安装是否需要更新、报告是否过期、doctor 上次结果如何：

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
bash ~/.pi/agent/scripts/pi67-status.sh --json
```

`pi-67 update` / `pi-67 update --repair` 会把 `settings.json` 的
`lastChangelogVersion` runtime marker 迁到 ignored 的
`~/.pi/pi67/state.json`，并从 `settings.json` 里物理移除它。若机器从旧版升级，
迁移还会移除旧的 repository-local Git clean filter；新版本不再需要 clean filter，
因为 `settings.json` 本身不进入 Git 索引。
其它 dirty 文件仍会正常报警。
`pi67-status.sh` 也会把历史遗留的 marker-only dirty 标成
`local runtime state only`，不把它当作普通本地改动阻断更新。它还会从本地 xtalpi smoke
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

配置公司 xtalpi、Codex、image-gen 或本地 MCP 路径时，可以使用工作台配置向导：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

自动化或无交互环境用 env，不要把 API key 放进 CLI 参数：

```bash
PI67_XTALPI_API_KEY="..." \
PI67_CODEX_API_KEY="..." \
PI67_IMAGE_GEN_API_KEY="..." \
bash ~/.pi/agent/scripts/pi67-configure.sh \
  --no-prompt \
  --tmwd-repo "/path/to/browser67"
```

`pi67-configure.sh` 会把 MCP 路径归一化为 adapter 可直接执行的绝对路径；
如果 Pi 报 `MCP error -32000: Connection closed`，先跑它再跑
`bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000`。

预览但不写入：

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --dry-run --no-prompt
```

配置向导只修改本地工作台运行态文件，不会把密钥写入仓库。Pi 的登录、模型选择和
下次启动恢复仍然使用 upstream 原生命令：

```text
/login
/model
```

公司 xtalpi key 也可以单独使用隐藏输入工具提前配置：

```bash
pi-67 xtalpi configure --verify
```

注意：pi-67 的安装和更新不会为了 key readiness 自动切换 `settings.json` 中的
provider/model；已选择的模型状态由 upstream Pi 维护。

也可以手动按 doctor 提示填写以下本地配置文件。它们不会提交到仓库：

```text
~/.pi/agent/models.json    <- 从 models.example.json 复制，填写 xtalpi/Codex 等自定义 provider key
~/.pi/agent/mcp.json       <- 从 mcp.example.json 复制，修改本地路径
~/.pi/agent/auth.json      <- upstream Pi /login 写入的认证状态；通常不需要手工编辑
~/.pi/agent/image-gen.json <- 从 image-gen.example.json 复制，填写 Codex key
```

## Rules 工作方式

Pi 的长期规则分两层：

1. `AGENTS.md` 是常驻内核，保持短小，定义不可外置的硬规则、工具分流、任务分级、Git 策略和交付闭环。
2. `rules/*.md` 是按需读取的长规则。`pi-rules-loader` 常驻暴露紧凑索引，并把当前 prompt 直接命中的 1-3 个规则全文注入本轮 system prompt；短上下文追问可继承同一 session 的最近 active route，明确换题则清空。没有命中但 `AGENTS.md` 明确要求的规则仍由 Pi 最小读取。

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
| 股票、财报、行业、组合、估值与投资报告 | `investment.md` |
| pi-67 安装、更新、provider、bootstrap、验收、发布 | `pi67-product-boundary.md` |

## 目录结构

```text
pi-67/
├── README.md
├── VERSION
├── CHANGELOG.md
├── install.sh                      # 一键符号链接安装脚本
├── .gitignore
├── AGENTS.md                       # Pi v1.8-pi 常驻短内核
├── settings.example.json           # tracked 核心配置模板
├── settings.json                   # ignored 本机 Pi 运行态（首次安装时创建）
├── models.example.json             # 模型配置模板（需填写 API key）
├── mcp.example.json                # MCP 服务配置模板（需修改路径）
├── auth.example.json               # 认证配置模板（需填写 API key）
├── image-gen.example.json          # 图片生成配置模板（需填写 API key）
├── package.json                    # npm 扩展包依赖列表
├── extensions/
│   ├── pi-rules-loader/            # Rules 索引注入扩展
│   │   └── index.ts
│   ├── pi-vision-bridge/           # 本地 vision_read 桥接工具
│   │   └── index.ts
│   ├── pi-hy-memory/               # 私有跨项目 Hy-Memory 扩展与 loopback wrapper
│   │   ├── index.ts
│   │   └── service.py
│   └── xtalpi-pi-tools/            # xtalpi 本地工具协议 provider
│       ├── config/                  # Runtime profiles 与配置边界
│       ├── protocol/                # 严格 action/parser/receipt 协议
│       ├── tools/                   # Tool schema 与重复执行策略
│       ├── transport/               # Request deadline 与 attempt budget
│       ├── turn/                    # Turn preparation/final/recovery 状态机
│       ├── index.ts
│       ├── provider-turn.ts         # 薄编排入口
│       ├── continuation.ts          # 承接指令统一判定
│       ├── tool-selection.ts        # Selected-tool 约束与排序
│       ├── parser.ts
│       ├── serializer.ts
│       ├── protocol.ts
│       ├── diagnostics.ts
│       ├── retry.ts                 # Legacy compatibility facade
│       └── stream.ts
├── rules/                          # Pi 按需读取长规则
│   ├── architecture-quality.md
│   ├── browser.md
│   ├── commerce-growth.md
│   ├── context-budget.md
│   ├── data-quality.md
│   ├── frontend.md
│   ├── investment.md
│   ├── performance.md
│   ├── pi67-product-boundary.md
│   ├── project-structure.md
│   └── quality.md
├── shared-skills/                  # 共享 Skills，安装到 ~/.agents/skills
│   ├── commerce-growth-os/         # Commerce 跨专业经营中枢
│   ├── commerce-commercial-strategy/
│   ├── commerce-operations/
│   ├── commerce-analytics/
│   ├── consumer-marketing-os/      # Marketing 跨专业编排中枢
│   ├── brand-strategy-communications/
│   ├── content-creative-social-marketing/
│   ├── growth-performance-lifecycle-marketing/
│   ├── investment-research/        # AI Berkshire 21-Skill Pack（其一）
│   ├── income-investment/
│   ├── financial-data/
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
│   ├── windows-fresh-install.md
│   └── xtalpi-pi-tools.md
├── prompts/                        # Pi Prompt 模板
│   ├── debug.md
│   ├── deliver.md
│   ├── frontend-kickoff.md
│   ├── review.md
│   └── scoped-commit.md
├── scripts/
│   ├── pi67-bootstrap.ps1
│   ├── pi67-check-external-skills.sh
│   ├── pi67-configure.sh
│   ├── pi67-doctor.sh
│   ├── pi67-doctor.ps1
│   ├── pi67-migrate-skills.sh
│   ├── pi67-prompt-governance-check.mjs
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
│   ├── pi67-sync-commerce-skill-pack.sh
│   ├── pi67-sync-commerce-skill-pack.mjs
│   ├── pi67-sync-commerce-growth-os.sh  # compatibility alias
│   ├── pi67-sync-ai-berkshire-skill-pack.sh
│   ├── pi67-sync-ai-berkshire-skill-pack.mjs
│   ├── pi67-test-ai-berkshire-skill-pack.sh
│   ├── pi67-sync-external-skills.sh
│   ├── pi67-test-skill-governance.sh
│   ├── pi67-update.sh
│   ├── pi67-update.ps1
│   ├── pi67-windows-acceptance.ps1
│   ├── pi67-uninstall.sh
│   ├── pi67-xtalpi-pi-tools.sh
│   ├── pi67-xtalpi-pi-tools.ps1
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

图片、截图、OCR、看图/读图任务不再交给晶泰 text-only 模型直接处理，也不会把
`.png/.jpg/.webp` 这类图片路径误路由给 `read`。`xtalpi-pi-tools` 会在本地先识别
vision task：优先 selected `vision_read`（由 `extensions/pi-vision-bridge/` 注册），
把图片转成文本证据后再让晶泰继续普通文本推理；如果没有 `vision_read` 但有
`image_review`，则走人工审查 fallback；如果两者都没有进入当前 turn 的工具白名单，
Pi 会直接返回 readiness error，提示修复本地 vision bridge，而不是让模型回答“我看不了图片”。
`vision_read` 默认读取 `models.json.providers.codex` 中 `input` 包含 `image` 的模型，
也可用 `PI67_VISION_PROVIDER`、`PI67_VISION_MODEL`、`PI67_VISION_BASE_URL`、
`PI67_VISION_API_KEY` 覆盖。

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
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
```

这个 PowerShell runner 覆盖 `read-package`、`read-enoent-recovery`、`plan-mode-contract`、`plan-mode-accepted-continuation`、`until-done-continuation`、`fffind-package`、
`ffgrep-package`、`batch-web-fetch-example`、`seq-thinking-status`、`mcp-status`、`subagent-list`
和 `recall-not-found` 这些低风险 targeted case；其中 `read-enoent-recovery` 会验证
`ENOENT -> recovery.repeated_tool -> fffind -> read(package.json)`，并确认相同缺失
`read` 没有被第二次真实执行。runner 为 FFF / sequential-thinking
使用临时隔离状态。PowerShell live runner 默认会对“工具调用、参数和 debug telemetry
都已正确但最终 assistant 文本为空”的瞬时模型/turn 结束抖动重试 1 次；可用
`-CaseRetries 0` 或 `XTALPI_PI_TOOLS_SMOKE_CASE_RETRIES=0` 关闭，不会重试
missing tool、错误参数、非零退出或 runtime error。完整 xtalpi full-suite runner 目前仍是 Bash 脚本；Windows 上
只有在显式具备 Bash-compatible shell 时才运行下面的 full-suite/live case，不要把
Git Bash 当成默认前置条件。下面 Bash 命令均假设已经在 agent repo 根目录。

排查 browser67 / `tmwd_browser` 的 MCP 启动层时，单独跑 connect case；它会真实执行
`mcp({"connect":"tmwd_browser"})`，因此要求本机已经安装 browser67 且 `mcp.json`
指向可启动的 browser67 checkout/package：

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "mcp-connect-tmwd-browser"
```

可选的受控启动（排障或显式覆盖 provider/model 时使用）：

```bash
pi-67 xtalpi run
```

Windows PowerShell：

```powershell
pi-67 xtalpi run
```

`pi-67 xtalpi run` 会使用 `xtalpi-pi-tools + deepseek-v4-pro + thinking off`，
并默认设置 `PI_OBSERVATIONAL_MEMORY_PASSIVE=true`，避免
`pi-observational-memory` 在 assistant final 之后继续发起后台
`record_observations` 请求、把主任务生命周期拖住。只有你明确需要自动记录
observational memory 时，才使用：

```bash
pi-67 xtalpi run --no-passive-observational-memory
```

它是可选的受控 launcher，不是新的日常入口；正常使用仍直接运行 `pi`。

底层 Bash launcher：

```bash
bash ./scripts/pi67-xtalpi-pi-tools.sh
```

底层 PowerShell launcher：

```powershell
.\scripts\pi67-xtalpi-pi-tools.ps1
```

静态测试：

```bash
bash ./scripts/pi67-test-xtalpi-pi-tools.sh
```

真实冒烟：

```bash
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh
```

真实冒烟覆盖 no-tool、bash、read、bash/read、web/read、`plan-mode-contract`、`plan-mode-accepted-continuation`、`read-enoent-recovery`、low-`maxTools` `tool-selection-clipping`、multi-turn `tool-selection-continuation`、`until-done-continuation`，以及 adversarial `tool-result-injection` 场景；可用 `--case plan-mode-contract` 单独复核 `<proposed_plan>` contract，用 `--case plan-mode-accepted-continuation` 单独复核“Plan mode 已关闭、执行已接受计划”不会递归生成 `<proposed_plan>` fallback，用 `--case read-enoent-recovery` 单独复核 `ENOENT` 后的重复调用阻断和替代发现链路，用 `--case tool-selection-clipping` 单独复核 selected-tool clipping telemetry，用 `--case tool-selection-continuation` 或 `--case until-done-continuation` 单独复核 continuation prompt source telemetry，也可用 `--case tool-result-injection` 单独复核工具结果注入边界与 canary confirmation gate。

targeted extension smoke 还覆盖 `fffind-package`、`ffgrep-package`、
`batch-web-fetch-example`、`seq-thinking-status`、`mcp-status`、`subagent-list`
和 `recall-not-found`；排查 browser67 MCP 启动时可额外显式运行
`mcp-connect-tmwd-browser`，它不进入默认低风险 profile，避免没有 browser67
checkout 的机器误触发外部依赖。PowerShell runner 额外提供 `read-package` 作为
Windows-native cwd-relative path 基线，并覆盖 plan-mode / accepted-plan continuation / until-done targeted contract。以上 extension case 默认不进入 full-suite；它们用于按需证明具体
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
`--profile extension-expanded`；默认不传 profile 仍是 12-case full-suite。

provider health 快速预检：

```bash
node ./scripts/pi67-xtalpi-provider-health.mjs
```

provider health 会输出结构化 JSON，并对瞬时 timeout/network/upstream/protocol 抖动做有界重试；`http_429` 只记录为 rate-limit，不做立即重试。
这些错误代码、分类、retryable 语义和 provider-health immediate retry 策略由 `extensions/xtalpi-pi-tools/provider-error-contract.json` 统一定义；contract 内置 `requiredCodes`、`allowedCategories`、`requiredHttpStatus` 和 `classificationSamples` manifest，运行时 provider、preflight 和 validator 共同读取，避免脚本和扩展长期漂移；修改该 contract 后运行 `node ~/.pi/agent/scripts/pi67-validate-xtalpi-provider-error-contract.mjs --self-test` 和 `node ~/.pi/agent/scripts/pi67-validate-xtalpi-provider-error-contract.mjs`。

日常 runtime provider 也会对可重试的 provider/transport 失败做本地有界重试：

```text
XTALPI_PI_TOOLS_REQUEST_ATTEMPTS=3
XTALPI_PI_TOOLS_RETRY_DELAY_MS=1000
XTALPI_PI_TOOLS_RETRY_MAX_DELAY_MS=8000
XTALPI_PI_TOOLS_RETRY_JITTER_MS=250
```

可重试范围包括 request timeout、network error、HTTP 408/5xx、非 JSON或 malformed response。
HTTP 429 会被分类为 rate-limit 且 `retryable=true`，但不会立即重试，避免在限流窗口里继续消耗请求。
连续失败会 fail closed，并在 debug/provider-health artifact 里写出 `attempt`、`attempt_count`、
`retry_count`、`retry_delay_ms` 和 `retry_suppressed_reason`。这能处理晶泰偶发抖动，但不等于
承诺上游连续 timeout 时永远不中断；连续失败时应看结构化错误分类，而不是把它当 Pi 工具协议回归。

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

targeted smoke 还会对“工具已经正确执行，但最终答案只缺少必填 marker / 版本号”的
final-answer-only failure 做一次本地 final compliance repair：runner 用 `--no-tools`
重新请求最终答案，只补齐 required final text，不重新执行工具、不重复副作用。工具缺失、
参数错误、runtime error、raw tool markup 泄漏或 timeout 不会走这个 repair，而是继续失败。

冒烟 telemetry 汇总：

```bash
bash ./scripts/pi67-xtalpi-pi-tools-debug-summary.sh --latest
```

详细说明见 `docs/xtalpi-pi-tools.md` 和 `docs/troubleshooting.md`。

**没有 xtalpi key 的用户**：完整配置仍会安装 `xtalpi-pi-tools` provider 模板，
但这不会阻止 `pi` 启动。直接运行 `pi`，再使用 `/login` 和 `/model` 选择任意 upstream
Pi 支持的 provider；认证和模型选择由 upstream Pi 保存并在下次启动恢复。doctor
可以提示对应模型请求尚未就绪，但不得把“没有晶泰 key”判定为 Pi 启动失败。

## 更新

upstream Pi runtime 与 pi-67 是两套独立生命周期，不能用一个更新命令跨边界修改。

### 只更新 upstream Pi runtime

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
```

### 只更新 pi-67 manager 和工作区

```bash
pi-67 update
pi-67 doctor
```

`pi-67 update` 会先检查 manager；只有提示 manager outdated 时才执行
`pi-67 self-update`，然后重新运行 `pi-67 update`。普通 update 检测到 managed npm
package 缺失或落后时会自动同步，不需要默认添加 `--repair`。

底层 updater 不再把“当前本地分支名”直接当作远端目标。目标分支解析顺序为：
显式 `--branch` / `-Branch`、同一 remote 的 configured upstream、远端同名分支、
与本地 `HEAD` 完全同 commit 的 remote default branch；其余情况 fail closed，要求
先切换到明确分支或显式传入目标。更新结束会输出 `git/config/skills/npm/verify`
各阶段和总耗时，便于定位慢点。

`pi-67 update` 可以只读报告 upstream Pi 的 installed/tested/latest 和兼容性，
但 pi-67 不会安装或更新 upstream Pi，也不会修复 upstream Pi。旧的
`pi-67 update --include-pi` 与跨所有权的 `pi-67 update --all` 已移除；继续使用会
以 `unknown option` 失败，而不是静默跨边界更新。

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

自动化或排障时用 JSON 预览：

```bash
pi-67 update --check --json
```

其中 `actions` 会列出计划写入和必须保留的路径，`blocked` 会列出 dirty repo、
strict shared-skill 差异等阻断项，`warnings` 会列出默认保留但需要人工了解的
状态；这样更新前可以明确知道 pi-67 会动什么、不会动什么。

管理器自身更新是显式动作，不会被普通 update 静默触发：

```bash
pi-67 self-update
```

维护者发布 npm 包前的一键检查：

```bash
pi-67 publish-check
pi-67 publish-check --json
```

`publish-check` 不只检查 npm 包元数据，也会检查 npm scope 可见性、首次发布
确认和 ownership manifest：保留 runtime config、主题不自动切换、shared skills
默认不覆盖、external dirty repo 阻断更新、必需 local extensions 存在，以及发行版
基线里不能混入未知 user-managed runtime package。若提示 `@bigking67` scope
不存在，需要先在 npm 创建/认领该用户或组织 scope，或把包名改成维护者拥有的
scope/name。若包从未发布过，严格检查会要求维护者在 npm scope 和 Trusted
Publisher 都配置完成后显式使用 `--allow-first-publish`；GitHub workflow 中对应
`first_publish_confirm=@bigking67/pi-67`。

查看 pi-67 对 packages、extensions、theme、shared skills、external repos 的
所有权边界：

```bash
pi-67 manifest
pi-67 manifest --json
pi-67 manifest --validate
pi-67 extensions doctor
pi-67 extensions inspect xtalpi-pi-tools
```

`pi-67 update --check` 和 `pi-67 extensions doctor` 也会检查 pi-67 管理的
npm 扩展 baseline。tracked `package-lock.json` 是唯一 release-tested 版本真源：
本机安装缺失或与锁版本不同，运行 `pi-67 update` 会通过 `npm ci` 确定性同步；
registry 出现比锁版本新的包时，即使仍满足 `package.json` semver 范围，也只显示
`baseline drift`，由维护者更新 lock、跑 smoke/release 后再发布新的 pi-67，员工
机器不会提前吸收未经当前 release 验证的版本。

查看和恢复 update/repair/theme-set 产生的 repo 外运行态备份：

```bash
pi-67 backups list
pi-67 backups inspect <backup-id-or-path>
pi-67 backups restore --from <backup-id-or-path> --dry-run
pi-67 backups restore --from <backup-id-or-path> --yes
```

扩展治理真源在 `packages/pi67-cli/src/data/extension-registry.json`。以后新增
provider、theme package、shared-skill pack、runtime package 或 external repo，
都必须先登记 owner、install/update/repair 策略、config patch mode 和 smoke gate；
`pi-67 manifest --validate`、`publish-check` 和 `release-check` 会复用同一个
registry validator，阻断重复 extension id、缺失 smoke gate、覆盖用户配置、
更新时切主题、覆盖不同 shared skill、更新 dirty external repo 这类行为漂移。

永远使用 npm 最新管理器的一次性命令：

```bash
npx -y @bigking67/pi-67@latest update
```

只有 update plan 看起来正常、但 `npm/node_modules` 仍损坏时，才显式执行
`pi-67 update --repair` 强制重装托管 npm dependencies。

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
# 只有排查 Skill drift 时才输出逐项 path/hash
.\scripts\pi67-update.ps1 -SkillDriftDetails
```

这个入口是一键日常更新：默认先 `git fetch`，再用 `git merge --ff-only
FETCH_HEAD` 完成 fast-forward，保留已有本地 key/config，只在 `models.json` /
`settings.json` / `mcp.json` / `auth.json` / `image-gen.json` 缺失时从对应
`.example` 创建。当前 `settings.json` 是 ignored 本机运行态，因此日常 provider、
model、theme 和 package 选择不会让仓库变脏。仅从旧版 tracked settings 升级时，
updater 才使用兼容备份/恢复流程保护本地修改；其他 tracked 本地改动仍会停止，
避免误覆盖。
更新流程还会把 `settings.json.lastChangelogVersion` 迁到
`$env:USERPROFILE\.pi\pi67\state.json`，并从 `settings.json` 里物理移除这个
runtime-only 字段；provider/model/theme/packages 不会被改，并移除旧版遗留的
repository-local Git clean filter。
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

1. 在 pi-67 仓库中执行 `git fetch` + `git merge --ff-only FETCH_HEAD`
2. 仅当 incoming 更新会触碰 dirty 用户运行态配置时，执行 backup -> temporary restore HEAD -> fast-forward -> restore user file，不覆盖主题和 key
3. 保留本地 `settings.json` / `models.json` / `mcp.json` / `auth.json` / `image-gen.json`
4. 如果新增本地配置模板，只复制缺失文件，不覆盖已有配置
5. 在备份后把可解析但编码不适合 Pi 启动的本地 JSON 规范化为 UTF-8 without BOM，例如 UTF-16、UTF-8 BOM 或前导 NUL 字节；备份名形如 `models.json.bak-YYYYMMDD-HHMMSS-encoding`
6. 只做确定性的 MCP 路径规范化，不改写 upstream Pi 的认证、provider/model 选择或持久化状态
7. 如果 tracked `package.json` / `package-lock.json` 与 `npm/` 运行态不一致，复制两者并通过 `npm ci` 确定性同步依赖
8. 检查并按需修补 `pi-until-done` runtime queue 兼容性
9. 运行 `scripts\pi67-smoke.ps1 -Ci` 复核 repo/update contract
10. 覆盖写入 `~/.pi/agent/pi67-report.json`，并默认嵌入 `scripts\pi67-doctor.ps1 -Json` 结果

`pi-67 update` 在 Windows 上会调度这个 PowerShell-native updater；在 macOS/Linux
上会调度 Bash updater。两边都遵守同一条主题策略：更新 theme package 可以，
但不会改 `settings.json` 里的 `theme` 选择。要改主题必须显式运行：

```bash
pi-67 themes current
pi-67 themes list
pi-67 themes set gruvbox-dark
```

`npm sync` 只在依赖清单或锁文件变化、安装缺失、或显式强制时运行；成功同步后
再次更新应显示 `npm package.json/package-lock.json already synced` 并跳过。
若只是临时想快速拉代码、确认当前依赖
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

如果你安装的是旧版，Windows 可以先更新轻量 bootstrap，再让它更新 manager 和
工作区：

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Update
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

发布脚本会在干净 checkout 缺少 ignored `npm/` 和 `settings.json` 时，分别从
tracked `package-lock.json` 和 `settings.example.json` 临时准备运行态；若这些目录或
文件由本次发布检查创建，退出时会清理。CI 同时覆盖 Ubuntu、macOS 和 Windows，
其中 Windows PowerShell 行为仍以 Windows CI/用户真机验收为最终证据。

生成发布计划和 release notes 预览：

```bash
bash scripts/pi67-release.sh --dry-run
```

正式创建 tag、push tag 并创建 GitHub Release：

```bash
bash scripts/pi67-release.sh --yes
```

GitHub Release 会同时上传 `pi67-bootstrap.ps1` 和
`pi67-bootstrap.ps1.sha256`，保证 Windows 新机文档中的 stable latest URL
始终指向经过当前 release gate 验证的脚本。

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

- 任何改动都必须保持“Pi 是运行时、pi-67 是工作台发行版与配置管理器”的边界；不得把 `pi-67` 变成平行运行时、强制启动器或 upstream Pi 的替代品。
- README 的项目定位和 `rules/pi67-product-boundary.md` 是本仓库的产品边界真源；修改安装、验收、CLI 或文档前先检查是否与它们一致。
- 不提交真实密钥、token、cookie、运行会话、缓存或本地私有状态。
- 修改全局行为时优先更新 `AGENTS.md`；长规则优先落到 `rules/`。
- 修改安装链路后运行 `bash scripts/pi67-smoke.sh`；至少覆盖 `bash -n`、JSON、dry-run、临时 agent-dir 安装和 doctor。
- 修改 skill registry 治理后运行 `bash scripts/pi67-test-skill-governance.sh`；需要核对真实外部 repo 时再运行 `bash scripts/pi67-check-external-skills.sh --repo /path/to/repo`。
- 修改版本、安装器、doctor、configure、report、release、update、restore/uninstall 或 CI 时，同步更新 `VERSION` / `CHANGELOG.md` / `docs/release.md`，并运行 `bash scripts/pi67-release-check.sh`。
- 提交前运行 `node scripts/pi67-prompt-governance-check.mjs`，并检查 prompt 模板使用 Pi 支持的 `$1` / `$ARGUMENTS` / `${...}`，避免常驻内核膨胀、能力名漂移或遗留双花括号占位符。

## 贡献

欢迎提 PR 或 Issue。如果你有好的 Pi 配置、Skills、Prompts 或规则治理方案，也欢迎贡献。

## License

MIT
