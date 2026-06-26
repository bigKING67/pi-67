# pi-67 — Pi Coding Agent 配置一站通

> 我的 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 全套可公开配置，面向长期使用、质量治理、真实工具链和规则化协作。

## 这是什么

这个仓库把 `~/.pi/agent/` 中可复用、可公开的 Pi 配置整理成可安装版本：

- 常驻内核：`AGENTS.md` 只保留硬规则、工具分流、rules 读取契约和交付闭环。
- 长规则外置：`rules/` 存放质量、架构、目录、性能、前端、浏览器、上下文和数据规则，按任务最小读取。
- 扩展补强：`extensions/pi-rules-loader/` 给 Pi 注入 rules 索引；`extensions/xtalpi-compat/` 处理 xtalpi 兼容。
- 生产力资产：Skills、Prompts、Docs、Templates 和脚本保持仓库化，便于审计、同步和回滚。

仓库不会提交真实 `auth.json`、`models.json`、`mcp.json`、`image-gen.json`、会话、缓存或运行历史；只提供 `.example` 模板。

## 包含内容

| 类别 | 内容 | 说明 |
|------|------|------|
| **核心配置** | `settings.json` | 默认 provider/model、17 个 Pi package 列表 |
| **模型配置** | `models.example.json` | xtalpi / xtalpi-tools / codex 三 provider 模板 |
| **MCP** | `mcp.example.json` | tmwd_browser、js-reverse、agent_memory 模板 |
| **全局内核** | `AGENTS.md` | Pi 常驻行为规范（v1.4-pi kernel） |
| **Rules** | `rules/` (8 篇) | 质量、架构、结构、性能、前端、浏览器、上下文、数据质量规则 |
| **自定义扩展** | `extensions/` (2 个) | `xtalpi-compat` + `pi-rules-loader` |
| **Skills** | `skills/` (31 个) | lark 飞书全系列 + 前端设计/输出/重设计技能 |
| **文档** | `docs/` (4 篇) | MCP 优化、爬虫指南、工具速查、xtalpi 配置 |
| **Prompts** | `prompts/` (5 个) | debug、deliver、frontend-kickoff、review、scoped-commit |
| **脚本** | `scripts/xtalpi-tool-smoke.sh` | xtalpi 工具冒烟测试 |
| **模板** | `templates/scrapers/` | 采集/合并/轮询相关脚本模板 |

## 快速开始

### 前置条件

```bash
# 已安装 pi
npm install -g @earendil-works/pi-coding-agent

# 首次运行 pi 生成 ~/.pi/agent/ 目录
pi --version
```

### 一键安装

```bash
git clone https://github.com/bigKING67/pi-67.git
cd pi-67
chmod +x install.sh
./install.sh
```

安装脚本会：

1. 备份已有配置（如果存在）
2. 创建符号链接，将仓库文件和目录映射到 `~/.pi/agent/`
3. 链接 `AGENTS.md`、`extensions/`、`skills/`、`docs/`、`prompts/`、`rules/`、`scripts/`、`templates/`
4. 提示配置 API key（从 `.example` 文件复制）
5. 安装 npm 扩展包
6. 刷新 Skills

### 手动配置

安装完成后，需要手动填写以下文件：

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
│   └── xtalpi-compat/              # xtalpi API 兼容层
│       └── index.ts
├── rules/                          # Pi 按需读取长规则
│   ├── architecture-quality.md
│   ├── browser.md
│   ├── context-budget.md
│   ├── data-quality.md
│   ├── frontend.md
│   ├── performance.md
│   ├── project-structure.md
│   └── quality.md
├── skills/                         # 31 个 Skills
│   ├── lark-*                      # 飞书全系列
│   ├── full-output-enforcement/
│   ├── high-end-visual-design/
│   ├── industrial-brutalist-ui/
│   ├── minimalist-ui/
│   ├── redesign-existing-projects/
│   └── stitch-design-taste/
├── docs/                           # 文档
│   ├── mcp-optimization-spec.md
│   ├── scraping-guide.md
│   ├── tool-cheatsheet.md
│   └── xtalpi-tools.md
├── prompts/                        # Pi Prompt 模板
│   ├── debug.md
│   ├── deliver.md
│   ├── frontend-kickoff.md
│   ├── review.md
│   └── scoped-commit.md
├── scripts/
│   └── xtalpi-tool-smoke.sh
├── templates/
│   └── scrapers/
└── themes/                         # 可选主题目录；不存在时安装脚本会跳过
```

## 关于 xtalpi

xtalpi 是晶泰科技内部 API。`models.example.json` 中包含 xtalpi / xtalpi-tools 两个 provider 配置，`extensions/xtalpi-compat/` 是对应兼容层。

**xtalpi 外部用户**：安装脚本会询问是否跳过 xtalpi 相关配置，你可以安全忽略并改用其他 provider。

## 更新

```bash
cd pi-67
git pull
# 符号链接自动生效，无需重新安装
# 如果 package 依赖有更新，运行：
cd ~/.pi/agent/npm && npm install
```

## 维护原则

- 不提交真实密钥、token、cookie、运行会话、缓存或本地私有状态。
- 修改全局行为时优先更新 `AGENTS.md`；长规则优先落到 `rules/`。
- 修改安装链路后运行 `bash -n install.sh`。
- 提交前检查 prompt 模板是否使用 Pi 支持的 `$1` / `$ARGUMENTS` / `${...}`，避免遗留双花括号占位符。

## 贡献

欢迎提 PR 或 Issue。如果你有好的 Pi 配置、Skills、Prompts 或规则治理方案，也欢迎贡献。

## License

MIT
