# pi-67 — Pi Coding Agent 配置一站通

> 我的 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 全套配置，开箱即用。

## 这是什么

把 `~/.pi/agent/` 下的所有配置、扩展、Skills、MCP、Prompts、文档整理到一起，方便其他人一键安装使用。

## 包含内容

| 类别 | 内容 | 说明 |
|------|------|------|
| **核心配置** | `settings.json` | 默认 provider/model、17 个扩展包列表 |
| **模型配置** | `models.example.json` | xtalpi / xtalpi-tools / codex 三 provider |
| **MCP** | `mcp.example.json` | tmwd_browser、js-reverse、agent_memory |
| **全局指令** | `AGENTS.md` | 完整的 agent 行为规范（v1.2-pi） |
| **自定义扩展** | `extensions/xtalpi-compat/` | xtalpi API 兼容层（工具过滤、结果镜像、空回复恢复） |
| **Skills** | `skills/` (31 个) | lark 飞书全系列（26 个）+ 前端设计（5 个） |
| **文档** | `docs/` (4 篇) | MCP 优化、爬虫指南、工具速查、xtalpi 配置 |
| **Prompts** | `prompts/` (5 个) | debug、deliver、frontend-kickoff、review、scoped-commit |
| **脚本** | `scripts/xtalpi-tool-smoke.sh` | xtalpi 工具冒烟测试 |

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
2. 创建符号链接，将仓库文件映射到 `~/.pi/agent/`
3. 提示配置 API key（`.example` 文件）
4. 安装所有 npm 扩展包
5. 刷新 Skills

### 手动配置

安装完成后，需要手动填写以下 `.example` 文件：

```
~/.pi/agent/models.json    ← 从 models.example.json 复制，填写 API key
~/.pi/agent/mcp.json       ← 从 mcp.example.json 复制，修改本地路径
~/.pi/agent/auth.json      ← 从 auth.example.json 复制，填写 DeepSeek key
~/.pi/agent/image-gen.json ← 从 image-gen.example.json 复制，填写 Codex key
```

## 目录结构

```
pi-67/
├── README.md
├── install.sh                    # 一键符号链接安装脚本
├── .gitignore
├── AGENTS.md                     # 全局 agent 行为规范
├── settings.json                 # pi 核心配置
├── models.example.json           # 模型配置（需填写 API key）
├── mcp.example.json              # MCP 服务配置（需修改路径）
├── auth.example.json             # 认证配置（需填写 API key）
├── image-gen.example.json        # 图片生成配置（需填写 API key）
├── package.json                  # npm 扩展包依赖列表
├── extensions/
│   └── xtalpi-compat/            # xtalpi API 兼容层
│       └── index.ts
├── skills/                       # 31 个 Skills
│   ├── lark-* (26 个)            # 飞书全系列
│   ├── full-output-enforcement/  # 完整输出强制执行
│   ├── high-end-visual-design/   # 高端视觉设计
│   ├── industrial-brutalist-ui/  # 工业粗野主义 UI
│   ├── minimalist-ui/            # 极简主义 UI
│   ├── redesign-existing-projects/ # 现有项目重设计
│   └── stitch-design-taste/      # 设计品味
├── docs/                         # 文档
│   ├── mcp-optimization-spec.md  # MCP 优化规格
│   ├── scraping-guide.md         # 爬虫指南
│   ├── tool-cheatsheet.md        # 工具速查表
│   └── xtalpi-tools.md           # xtalpi 工具配置
├── prompts/                      # Prompt 模板
│   ├── debug.md
│   ├── deliver.md
│   ├── frontend-kickoff.md
│   ├── review.md
│   └── scoped-commit.md
├── scripts/
│   └── xtalpi-tool-smoke.sh      # 冒烟测试
├── templates/
│   └── scrapers/
└── themes/
```

## 关于 xtalpi

xtalpi 是晶泰科技内部 API。`models.example.json` 中包含 xtalpi/xtalpi-tools 两个 provider 配置，`extensions/xtalpi-compat/` 是专门的兼容层。

**xtalpi 外部用户**：安装脚本会询问是否跳过 xtalpi 相关配置，你可以安全忽略。

## 更新

```bash
cd pi-67
git pull
# 符号链接自动生效，无需重新安装
# 如果 packages 有更新，运行：
cd ~/.pi/agent/npm && npm install
```

## 贡献

欢迎提 PR 或 Issue。如果你有好的 pi 配置、Skills、Prompts 也欢迎贡献。

## License

MIT