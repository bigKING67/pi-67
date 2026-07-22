# pi-67 发行流程

适用版本：`0.15.0`。本文面向维护者。普通 install/update 不执行本文的 publish、
tag、push 或 GitHub Release 操作。

## 1. 发行合同

一个 pi-67 release 必须同时证明：

1. manager package version 与 distro `VERSION` 相同；
2. npm artifact 内含完整、可校验、不可变 distro；
3. 安装/更新不 clone/pull GitHub `main`；
4. 21 个 default extension minimum baselines 完整；
5. ahead extension 不降级，diverged/unknown 不覆盖；
6. 27 个 Lark Skills 全部 bundled；
7. Commerce/Marketing 与 AI Berkshire 为 pi67-first-party bundled assets；
8. `pi-observational-memory` 与 `pi-hy-memory` 的职责分别是 session compression
   和 cross-session long-term memory；
9. 个人 `agent_memory` 不进入公共 template/manifest/baseline，但 migration fixture
   证明本机配置会保留；
10. Pi version management 完全在 pi-67 之外；
11. packed artifact 在隔离 prefix/HOME 中真实安装并运行；
12. Git tag/GitHub Release 只使用已提交的精确 HEAD 资产。

## 2. 授权层

分别确认：

| 动作 | 需要的用户授权 |
| --- | --- |
| 修改、测试、commit | 实现/commit 授权 |
| push | 当前明确 push 授权 |
| npm publish | 当前明确 publish 授权 |
| Git tag/GitHub Release | 当前明确发布授权 |
| 升级本机全局 manager/Pi/Lark CLI | 当前明确全局依赖变更授权 |

“commit”不等于 push/publish/release。

## 3. 版本文件

以下必须一致：

```text
VERSION
package.json
package-lock.json
packages/pi67-cli/package.json
packages/pi67-cli/CHANGELOG.md
CHANGELOG.md
README.md
```

检查：

```bash
version=$(tr -d '[:space:]' < VERSION)
node -e 'const fs=require("fs"); for (const f of process.argv.slice(1)) console.log(f, JSON.parse(fs.readFileSync(f)).version)' package.json packages/pi67-cli/package.json
grep -n "\[$version\]" CHANGELOG.md packages/pi67-cli/CHANGELOG.md
```

不要让 npm manager 与 bundled distro 使用不同版本号。

## 4. Extension baseline gate

Canonical registry：

```text
packages/pi67-cli/src/data/managed-extension-baselines.json
```

检查：

```bash
jq '.schema, (.extensions | length)' packages/pi67-cli/src/data/managed-extension-baselines.json
node packages/pi67-cli/scripts/check.mjs
```

必须是 17 个 npm/Git + 4 个 bundled first-party，总数 21。每个 npm baseline 包含
精确 minimum version 和 package-tree SHA-256；Git baseline 包含 origin 和 commit；
bundled baseline 包含 bundle path、version 和内容 hash。

状态回归至少覆盖：

```text
missing -> install
behind pristine -> upgrade
equal pristine -> keep
ahead -> keep
lower/equal modified -> keep-conflict
source/fork/diverged -> keep-conflict
unknown -> keep
successful pi list omits configured spec -> load-failed
```

`pi-until-done` 与 `pi-smart-fetch` compatibility patch 只能在 manager 安装/升级精确
匹配内容后调用。

## 5. Immutable distro bundle

`packages/pi67-cli/scripts/build-distro-bundle.mjs` 只复制明确 allowlist，排除：

```text
.git/
node_modules/
__pycache__/
*.pyc
machine-owned settings/auth/models/mcp/sessions
```

prepack 生成：

```text
packages/pi67-cli/distro/
packages/pi67-cli/distro/.pi67-bundle.json
```

manifest 逐文件记录 path、size、SHA-256，且不写动态时间戳，减少不可复现内容。
postpack 清理生成目录。

手工查看 artifact：

```bash
cd packages/pi67-cli
node scripts/build-distro-bundle.mjs
npm pack --ignore-scripts --json
node scripts/clean-distro-bundle.mjs
```

不要把生成的 `distro/` 或 `.tgz` 提交到 Git。

## 6. Shared Skill Pack parity

两个 first-party Pack：

```text
consumer-brand-commerce-marketing-suite
ai-berkshire-investment-suite
```

registry/lock：

```text
shared-skill-packs.json
shared-skill-packs.lock.json
```

metadata 必须为：

```text
owner=pi67-first-party
distribution=bundled-release-only
```

维护者从受控 source 生成 vendored baseline：

```bash
bash scripts/pi67-sync-commerce-skill-pack.sh --dry-run
bash scripts/pi67-sync-ai-berkshire-skill-pack.sh --dry-run
```

当 source、manifest、skill set、version 和 lock 已完全一致时，helper 必须
report `NOOP`。若需要更新，先审阅 dry-run，再按脚本要求显式 apply，随后重新运行：

```bash
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
```

维护 helper 可以引用受控 source provenance，但用户 `pi-67 update` 不自动从这些
source 拉取 runtime assets。

Lark inventory 必须为 27；normal update 保留 active conflicts，只补 missing。

## 7. Memory boundary gate

公共默认：

```text
pi-observational-memory -> session-compression
pi-hy-memory            -> cross-session-long-term-memory
```

检查：

```bash
rg -n "agent_memory" mcp.example.json settings.example.json packages/pi67-cli/src/data README.md docs
```

允许命中：历史 changelog、Hy-Memory 边界说明、migration preservation fixture。
禁止命中：公共 MCP template、extension baseline/manifest、推荐安装配置。

## 8. Pi independence gate

当前实现和文档不得出现 Pi version policy：

```bash
rg -n --glob '!CHANGELOG.md' --glob '!packages/pi67-cli/CHANGELOG.md' \
  "upstreamPi|testedVersion|installedBehindTested|pi-coding-agent@latest" \
  README.md docs packages/pi67-cli/src scripts
```

预期只有明确的负向 regression assertion；不应存在 status script、registry query、
upgrade command 或 manifest ownership entry。doctor 可检查 `pi` command 和真实
`pi list --no-approve` load path。

## 9. Targeted validation

先跑最相关 gate：

```bash
node packages/pi67-cli/scripts/check.mjs
node scripts/pi67-prompt-governance-check.mjs
npm run typecheck:xtalpi
npm run typecheck:hy-memory
npm run test:rules-loader
npm run test:xtalpi
npm run test:hy-memory
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
```

Windows script syntax/contract 由 PowerShell self-test、CI 或真实 Windows runner 验收；
非 Windows host 不能把文本 grep 冒充原生 PowerShell 运行证据。

## 10. Full local gates

```bash
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-check.sh
bash scripts/pi67-release-artifact-smoke.sh
```

`scripts/pi67-release-check.sh` 校验 metadata、schemas、docs、extension/Skills/memory/
Pi boundaries、typechecks/tests 和 Git tracked scope。

`scripts/pi67-release-artifact-smoke.sh` 生成隔离 release artifact；它证明 Git release
资产，不替代 npm tarball install gate。

## 11. Packed artifact isolation gate

必须实际执行 package-contained gate：

```bash
node packages/pi67-cli/scripts/check.mjs
```

其中 `scripts/checks/installed-artifact.mjs` 应：

1. build distro；
2. `npm pack --ignore-scripts`；
3. 解包/安装到隔离 prefix；
4. 使用隔离 HOME；
5. 从 installed package 执行真实 CLI；
6. 验证 `distro/VERSION` 和 `.pi67-bundle.json`；
7. 验证 install/update dry-run 不含 Git clone；
8. 验证 memory/help 和关键 commands 在 tarball 中可加载。

如果出现 `MODULE_NOT_FOUND`，即使 source smoke、CI 或 publish-check 通过，也不得
发布。

## 12. Schema validation

至少验证：

```text
pi67-distro-manifest.schema.json
pi67-update-plan.schema.json
pi67-extension-registry.schema.json
pi67-publish-check.schema.json
pi67-state.schema.json
```

使用 Draft 2020-12 validator 校验真实 CLI JSON，而不只是 `JSON.parse` schema 文件。
典型输入：

```bash
pi-67 manifest --json > /tmp/pi67-manifest.json
pi-67 update --check --no-remote --json > /tmp/pi67-update-plan.json
```

验证 artifact 只放 `/tmp` 或 CI artifact，不提交。

## 13. 性能与大小

记录：

```bash
du -sh packages/pi67-cli/distro 2>/dev/null || true
npm pack --ignore-scripts --json
```

关注：

- packed/unpacked size；
- 文件数量；
- build/stage/activate duration；
- repeated activation 是否 no-op；
- same-version collision 是否 fail closed；
- legacy migration 对大型 `npm/git/sessions` 的磁盘与时间成本。

不要为减小 artifact 删除默认扩展、27 个 Lark Skills、Commerce/Marketing 或 AI
Berkshire。先优化重复文件、生成产物和无用 assets。

## 14. `publish-check`

```bash
pi-67 publish-check --json --no-remote
pi-67 publish-check --strict --json
```

strict remote check 应验证 package name、version 是否已存在、registry 状态、
Trusted Publishing workflow 和 Git cleanliness/HEAD contract。源码测试不应自行 publish。

## 15. npm Trusted Publishing

仅在明确发布授权后，通过 `.github/workflows/npm-publish.yml` 执行。workflow 必须：

- 使用 npm 支持 Trusted Publishing 的版本；
- `id-token: write`；
- 不保存长期 npm token；
- 先跑 release gates；
- 执行 `npm publish ... --access public`；
- 验证 exact package version；
- 验证 `latest` dist-tag 指向该版本。

发布后真实验证：

```bash
npm view @bigking67/pi-67@0.15.0 version
npm view @bigking67/pi-67@latest version
```

然后在新的隔离目录执行真实 global/npx smoke。`npm pack --dry-run` 不足以证明
registry artifact 可用。

## 16. Git commit

发行前先复核：

```bash
git status --short
git diff --check
git diff --stat
git diff --name-only
```

只 scoped stage 本次任务文件，不使用 `git add -A`；不带入嵌套第三方 checkout
lockfile、生成 distro、tarball、真实 runtime config、credentials 或 session。

commit 不等于 push。

## 17. Tag 与 GitHub Release

仅在 npm exact/latest artifact 验证通过、且用户明确授权发布后：

1. 确认 release commit 已 push 且 CI green；
2. 创建 annotated tag；
3. `scripts/pi67-release.sh` 从 exact committed HEAD 取得 bootstrap assets；
4. 生成 `pi67-bootstrap.ps1.sha256`；
5. 使用 `gh release create`；
6. 下载 release assets 并重新校验 checksum；
7. 不从 dirty worktree 上传文件。

GitHub Release 之前必须确认 npm exact 和 `latest` dist-tag，避免发布一个指向不存在
manager 的 bootstrap。

## 18. 发布后运行态验收

至少分层验证：

```bash
command -v pi-67
npm prefix -g
pi-67 version --json
pi-67 manifest --validate
pi-67 update --check --json
pi-67 extensions doctor --deep --json
pi-67 doctor --json
```

报告 manager version、distro version、release path、21 extension summary、Skill
missing/conflicts 与唯一 warning。不要把 npm `latest` 等同于当前 shell 已升级。

## 19. 回滚

发行后的用户 workspace 回滚：

```bash
pi-67 rollback --check --json
pi-67 rollback --yes
```

npm/tag/GitHub Release 回滚属于独立外部动作，必须重新授权并遵循 registry/GitHub
不可变性策略。不要 unpublish 或改写 Git 历史作为常规回滚方式。

## 20. Release checklist

- [ ] 版本文件和 changelog 一致；
- [ ] 21 extension baselines 完整且 hash/commit 可复现；
- [ ] ahead/diverged/load-failed 回归通过；
- [ ] immutable collision/no-op/pending recovery 回归通过；
- [ ] 27 Lark + 8 Commerce/Marketing + 21 AI Berkshire 默认保留；
- [ ] first-party Pack metadata 正确；
- [ ] 两层 memory 角色正确且个人 MCP 未分发；
- [ ] Pi version policy 已完全移除；
- [ ] schema 用真实 payload 验证；
- [ ] shell/PowerShell/Node/typecheck/tests 通过；
- [ ] packed artifact 隔离安装通过；
- [ ] `git diff --check` 与 scoped status 通过；
- [ ] 已明确区分 commit、push、publish、tag、GitHub Release；
- [ ] 发布后 exact/latest/installed runtime 分层验收完成。
