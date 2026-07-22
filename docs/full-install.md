# pi-67 完整安装、迁移与更新

适用版本：`0.15.0`。

本文只描述 pi-67 工作台。upstream Pi 是独立底座，用户按 upstream 方式单独
安装和维护；pi-67 不安装、更新、比较或推荐 Pi 版本。

## 1. 安装后的组成

```text
pi                             独立 upstream runtime
@bigking67/pi-67               npm 全局 manager
~/.pi/agent                    激活的 pi-67 工作台
~/.pi/pi67/releases/<version>  manager 内置 distro 的不可变落盘副本
~/.pi/pi67/current.json        当前 release pointer
~/.pi/pi67/extension-ledger.json
~/.agents/skills               active shared Skills
~/.agents/packages             browser67 等 external packages
```

以上 state 路径对应 canonical `~/.pi/agent`。其他 `--agent-dir` 使用
`~/.pi/pi67/workspaces/<sha256(agentDir) 前 16 位>/`，独立保存 release pointer、
extension ledger、locks、backups、journals、migrations、reports 和 runtime
state。`pi-67 version --json` / `pi-67 status --json` 的 `paths.stateDir` 是
现场真值。

`~/.pi/agent` 从 0.15.0 起不是要求用户维护的 Git checkout。标准 install/update
不会 clone 或 pull GitHub `main`。

工作台内的 `AGENTS.md` kernel 为 `v1.8-pi`，通过 `pi-rules-loader` 按需路由 11 个
长规则；安装验收应同时验证 kernel、rules index 和真实 Pi 配置加载。
The distribution contains 11 rule files.

## 2. 前提检查

macOS/Linux：

```bash
node --version
npm --version
command -v pi
command -v pi-67 || true
```

Windows PowerShell：

```powershell
node --version
npm --version
Get-Command pi -ErrorAction SilentlyContinue
Get-Command pi-67 -ErrorAction SilentlyContinue
```

要求：

- Node.js 22.19+ 或 24 LTS；
- npm global prefix 对当前用户可写；
- `pi` 命令已独立安装；
- npm 可访问 `@bigking67/pi-67`；
- 真实 credentials 不放入 repo、命令历史、日志或文档。

## 3. 全新安装

0.15.0 正式发布后：

```bash
npm install --global @bigking67/pi-67@0.15.0
pi-67 install
pi-67 version --json
pi-67 doctor --json
pi
```

Windows：

```powershell
npm install --global @bigking67/pi-67@0.15.0
pi-67 install
pi-67 version --json
& "$env:USERPROFILE\.pi\agent\scripts\pi67-doctor.ps1" -Json
pi
```

安装过程：

1. 从当前 manager artifact 读取同版本内置 distro；
2. 校验 `.pi67-bundle.json` 中每个文件的 SHA-256；
3. 将发行资产落到 `<stateDir>/releases/0.15.0`；
4. 原子激活 package-owned 工作台文件；
5. 保留所有 machine-owned runtime state；
6. 安装 missing 或安全 behind 的默认扩展最低基线；
7. 只补齐 missing shared Skills；
8. 写入 release pointer、journal 和 extension ledger。

同一版本已有不同内容时安装会拒绝继续。重复激活当前版本不会再次复制全部资产。

## 4. 已存在目录的分流

### 4.1 已是 immutable layout

```bash
pi-67 update --check --json
pi-67 update
```

### 4.2 legacy Git checkout

先预览：

```bash
pi-67 migrate --check --json
```

确认输出中的：

- `legacyGitCheckout=true`；
- `targetVersion` 正确；
- `preserves` 包含 runtime files 与四个 runtime directories；
- backup 位于 `<stateDir>/backups`。

再执行：

```bash
pi-67 migrate --yes
pi-67 doctor --json
```

迁移采用 rename-first：原 checkout 先整体移动到 backup，再创建新 active workspace。
这使失败时可以立即把原目录 rename 回去。随后复制下列保留状态：

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

大型 `npm/`、`git/` 或 `sessions/` 会影响迁移耗时和临时磁盘占用；迁移前可用
`du -sh ~/.pi/agent/{npm,git,sessions,extensions}` 评估，但不要删除用户数据来换取
速度。

回滚 legacy layout：

```bash
pi-67 rollback --migration --check
pi-67 rollback --migration --yes
```

### 4.3 非空但来源不明

`pi-67 install` 不会接管未知非空目录。先备份和确认内容来源，再决定是否按 legacy
migration 处理；不要用 `--repair` 绕过所有权边界。

## 5. 默认扩展最低基线

发行版保留 21 个默认扩展：17 个 npm/Git package 和 4 个 bundled first-party
extensions。更新决策：

```text
missing                  -> install
safe behind + pristine   -> upgrade
equal                    -> keep
ahead                    -> keep, never downgrade
modified/diverged/fork   -> keep-conflict
unknown                  -> keep user-managed
load probe unresolved    -> load-failed, keep-conflict
```

查看而不写入：

```bash
pi-67 extensions list --json
pi-67 extensions plan --json
pi-67 extensions status --deep --json
pi-67 extensions doctor --deep --json
```

`--deep` 会执行真实 `pi list --no-approve` package resolution probe；它不读取 Pi
版本。普通 status/update plan 不启动该 probe，避免给日常热路径增加额外进程成本。

本机主动升级某个第三方扩展后，只要版本高于 pi-67 minimum baseline，后续更新
保持该版本。相同/较低版本但内容不同也不会被静默覆盖。

显式恢复单个 default extension：

```bash
pi-67 extensions diff <id> --json
pi-67 extensions restore <id> --check --json
pi-67 extensions restore <id> --yes
```

restore 会先备份且只替换选中的 ID。

## 6. 两层公共记忆

- `pi-observational-memory`：session 内观察与压缩；
- `pi-hy-memory`：跨 session 长期记忆。

个人 `agent_memory` MCP 不在公共模板、manifest、baseline 或安装指引中。如果它已
存在于 ignored `mcp.json`，install/update/migrate/repair/rollback 全部保留它；
pi-67 不接管其进程、数据或升级。

Hy-Memory 初始化：

```bash
pi-67 memory status --json
pi-67 memory init --dry-run
pi-67 memory init
pi-67 memory doctor --deep
```

详见 `docs/hy-memory.md`。

## 7. Shared Skills

默认 bundle 共有 62 个 Skills，其中包括：

- 27 个 Lark Skills；
- 8 个 Commerce/Marketing Skills；
- 21 个 AI Berkshire Skills。

Commerce/Marketing 和 AI Berkshire 是 `pi67-first-party`、
`bundled-release-only`。用户机器不从第三方 source 自动刷新这两个 Pack；新版本只
能随维护者发布的新 pi-67 baseline 到达。

```bash
pi-67 skills inventory
pi-67 skills packs --json
pi-67 skills plan
```

正常更新仅复制 missing Skill。active 内容不同则保留并报告 conflict。显式覆盖必须
使用 `skills sync-pack <pack> --yes`，并受 deploy lock 和事务备份保护。

旧 Skills 目录迁移与 external sync 辅助工具仍可用于维护：

```bash
bash scripts/pi67-migrate-skills.sh --dry-run
bash scripts/pi67-sync-external-skills.sh --dry-run
```

这两个工具不是用户更新 first-party Pack 的默认路径。

## 8. 更新

先显式更新 npm manager，再让 manager 激活自身 distro：

```bash
pi-67 self-update --dry-run
pi-67 self-update
pi-67 update --check --json
pi-67 update
```

离线计划：

```bash
pi-67 update --check --no-remote --json
```

修复与限制：

```bash
pi-67 update --repair
pi-67 update --no-npm
pi-67 update --check --strict-shared-skills --json
```

`--repair` 不执行整个 `~/.pi/agent/npm` 的 lockfile 收敛。它只处理能证明安全的
最低 extension baseline、package-owned assets 和 missing Skills。

## 9. Immutable release 回滚

```bash
pi-67 rollback --check --json
pi-67 rollback --yes
```

rollback 激活 pointer 中记录的 previous release。它不会删除当前 release store，
因此可审计且可再次切换。machine-owned runtime state 和 user-managed extension
目录继续保留。

## 10. Windows bootstrap

如果 manager 尚未安装，可使用已发布 GitHub Release 中经过 checksum 校验的
`pi67-bootstrap.ps1`：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\pi67-bootstrap.ps1
```

bootstrap 只负责 Node/npm 检查、pi-67 manager 安装和 workspace install/update；
它不安装 Pi。完成后运行：

```powershell
pi-67 update --check --json
& "$env:USERPROFILE\.pi\agent\scripts\pi67-doctor.ps1" -Json
& "$env:USERPROFILE\.pi\agent\scripts\pi67-smoke.ps1" -Ci
& "$env:USERPROFILE\.pi\agent\scripts\pi67-windows-acceptance.ps1"
```

完整流程见 `docs/windows-fresh-install.md`。

## 11. browser67 与 xtalpi

browser67：

```bash
pi-67 external install browser67 --dry-run
pi-67 external install browser67 --yes
pi-67 external doctor browser67 --deep
```

external repo dirty 时更新 fail closed。

xtalpi：

```bash
pi-67 xtalpi configure --verify
pi-67 xtalpi smoke --quick
```

xtalpi 是 optional convenience；零凭据 Pi startup 不应依赖它。

## 12. 验收

最低验收：

```bash
pi-67 version --json
pi-67 manifest --validate
pi-67 update --check --json
pi-67 extensions doctor --deep --json
pi-67 doctor --json
pi
```

开发/发行验收：

```bash
node packages/pi67-cli/scripts/check.mjs
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-check.sh
bash scripts/pi67-release-artifact-smoke.sh
```

packed artifact 必须在隔离 HOME/prefix 中真实安装运行，不能仅用源码 smoke 代替。

## 13. 安全边界

- 不把 token、cookie、password、private key 写入 Git、artifact、日志或 fixtures；
- 不覆盖 `auth.json`、`mcp.json`、`models.json` 或用户 theme；
- 不 reset/clean dirty external repo；
- 不把 unknown extension 猜成 pi-67-owned；
- 不在普通 update 中发布 npm、创建 GitHub Release、push 或升级 Pi。
