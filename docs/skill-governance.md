# pi-67 Shared Skill 治理

适用版本：`0.15.0`。

## 1. 三层模型

```text
shared-skills/                         pi-67 bundled source of truth
shared-skill-packs.json                Pack ownership/distribution registry
shared-skill-packs.lock.json           immutable provenance and content hashes
~/.agents/skills/                      active user-visible Skill root
```

normal install/update 的职责是保证默认 Skills 不缺失，不是强制把 active root 与
bundle 做字节级锁定。

## 2. 默认更新策略

| Active 状态 | 行为 |
| --- | --- |
| missing | 从 bundled source 复制 |
| identical | no-op |
| different/conflict | 保留 active 内容并报告 |
| duplicate legacy root | 报告并引导迁移，不静默删除 |
| strict mode conflict | block，但仍不覆盖 |

这与 extension minimum baseline 一致：用户已经自行更新/维护的内容不被旧 pi-67
覆盖。

## 3. 发行版必备集合

0.15.0 bundle 共有 62 个 shared Skills，必须包含：

- 27 个 Lark Skills，包含 `lark-apps`、`lark-note`；
- 8 个 Commerce/Marketing Skills；
- 21 个 AI Berkshire Skills；
- 其他公共工作台 Skills。

任何默认 Skill 的移除都需要明确产品决策、迁移说明和 release note，不能为了
artifact size 或让 conflict count 变小而删除。

## 4. First-party Packs

### Commerce/Marketing

```text
consumer-brand-commerce-marketing-suite
```

8 个 Skills：

```text
commerce-growth-os
commerce-commercial-strategy
commerce-operations
commerce-analytics
consumer-marketing-os
brand-strategy-communications
content-creative-social-marketing
growth-performance-lifecycle-marketing
```

### AI Berkshire

```text
ai-berkshire-investment-suite
```

21 个 value-investing/research/publishing Skills，以 registry 中的 canonical list 为准。

两个 Pack 的产品 metadata：

```json
{
  "owner": "pi67-first-party",
  "distribution": "bundled-release-only"
}
```

含义：

- 用户机器只从已发布 pi-67 artifact 获得 baseline；
- `pi-67 update` 不自动拉取第三方 runtime source；
- 维护者可使用受控 source/provenance 生成新版 bundle；
- 只有 pi-67 维护者更新、测试并发布新版本后，用户才有机会升级这些 Skills。

## 5. Registry 与 lock

`shared-skill-packs.json` 定义：

```text
name
version
owner
distribution
skills[]
source/provenance metadata
```

`shared-skill-packs.lock.json` 定义：

```text
source_commit
manifest_sha256
bundle_sha256
skills[].sha256
```

`upstream` 对 first-party bundled-only Pack 可以为空；运行时不得因 URL 为空而
自动 fallback 到网络。维护生成 helper 若需要 source repo，必须由维护者显式提供并
验证 origin/commit/dirty state。

## 6. 用户命令

只读：

```bash
pi-67 skills inventory
pi-67 skills inventory --json
pi-67 skills packs --json
pi-67 skills plan
pi-67 skills diff <skill-name>
```

normal update：

```bash
pi-67 update --check --json
pi-67 update
```

只补 missing，保留 conflicts。

strict preview：

```bash
pi-67 update --check --strict-shared-skills --json
pi-67 doctor --strict-shared-skills --json
```

显式 pack overwrite：

```bash
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
pi-67 skills sync-pack ai-berkshire-investment-suite --dry-run
pi-67 skills sync-pack ai-berkshire-investment-suite --yes
```

`sync-pack --yes` 使用 deploy lock、staging、backup/transactional replace；它是用户
明确选择覆盖 Pack 的管理命令，不是 normal update 的隐式副作用。

## 7. Lark Skills

默认 27 个 Lark Skills 全部保留。active Lark Skill 与 bundle 不同的常见原因是用户
已经在本机升级或维护了更高版本；normal update 保留它。

验收关注：

```text
missing=0
conflicts 可非零但必须 preserved
strict mode 能识别 conflict
normal update 无 overwrite action
```

不能为了 doctor 变成全绿而强制覆盖 active Lark Skills。

## 8. Maintainer vendoring

Commerce helper：

```bash
bash scripts/pi67-sync-commerce-skill-pack.sh --dry-run
```

AI Berkshire helper：

```bash
bash scripts/pi67-sync-ai-berkshire-skill-pack.sh --dry-run
```

维护流程：

1. source checkout 存在且 origin/commit 符合预期；
2. tracked worktree clean；
3. manifest 与 Skill set 完整；
4. referenced scripts/licenses/provenance 可解析；
5. dry-run 展示 add/update/remove；
6. apply 使用 staging 生成完整新 bundle；
7. 原子替换 bundle/registry/lock；
8. 删除上游移除的 Skill 仅在旧目录仍匹配旧 lock 时允许；
9. 运行 full governance tests；
10. scoped commit。

同 source/commit/content/version 重跑必须返回 `NOOP`。如果 Skill set 删除等破坏性
变化需要 major version，helper 必须 fail closed 或要求明确 version bump。

## 9. Legacy migration

旧 active roots 可以使用：

```bash
bash scripts/pi67-migrate-skills.sh --dry-run
bash scripts/pi67-migrate-skills.sh --apply
```

原则：

- missing 才复制；
- conflict 拒绝覆盖；
- 迁移前备份；
- 不删除未知 Skill；
- 输出 schema-valid report。

## 10. External Skill sync

非 first-party external repository 可使用：

```bash
bash scripts/pi67-sync-external-skills.sh --dry-run
bash scripts/pi67-sync-external-skills.sh --apply
bash scripts/pi67-check-external-skills.sh
```

external sync 与 bundled first-party Pack 是两个不同边界。它不得成为 Commerce/AI
Berkshire 的用户 runtime auto-update path。

输入过滤：

- 接受目录级或 root-level `SKILL.md`；
- 排除 `.git`、cache、build、logs、credentials；
- symlink 或 source conflict fail closed；
- active conflict 不覆盖。

## 11. Concurrency 与 transaction

Skill deploy 使用 lock，避免两个 sync 同时替换 active root。持锁操作必须：

1. 检查现有 lock owner/time；
2. staging 完整目标；
3. 验证 hash；
4. 备份目标；
5. 原子切换；
6. 失败恢复；
7. finally 释放 lock。

无变更 no-op 不应长期占锁或产生备份。

## 12. 验证

```bash
node packages/pi67-cli/scripts/check.mjs
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
node scripts/pi67-shared-skill-packs-status.mjs --json
pi-67 skills packs --json
```

release gate 必须验证：

- Pack registry/lock schema；
- owner/distribution；
- skill count 与 canonical list；
- bundle/skill hashes；
- licenses/provenance；
- missing/conflict/no-op/transaction/dirty-source/symlink failure；
- 27 Lark inventory；
- packed artifact 包含全部 shared Skills。

## 13. 安全与 Git

- 不 vendoring uncommitted source；
- 不把 token/credentials 写入 UPSTREAM/provenance；
- 不修改 unknown active Skill；
- 不用 `git add -A`；
- 不把 source checkout、cache、生成日志、temporary staging 提交；
- commit 不等于 push；
- first-party Pack 更新必须由 pi-67 release 交付，而不是用户端网络 fallback。
