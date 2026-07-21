#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNC="$ROOT/scripts/pi67-sync-ai-berkshire-skill-pack.sh"
CLI="$ROOT/packages/pi67-cli/bin/pi-67.mjs"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi67-ai-berkshire-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass_count=0

pass() {
  pass_count=$((pass_count + 1))
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

assert_json() {
  local file="$1"
  local expression="$2"
  local label="$3"
  node - "$file" "$expression" <<'NODE' || fail "$label"
const fs = require("node:fs");
const [file, expression] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Function("data", `return Boolean(${expression})`)(data)) process.exit(1);
NODE
  pass "$label"
}

make_fixture() {
  local name="$1"
  local source="$TMP/$name"
  mkdir -p "$source/codex-skills/sample-skill" "$source/tools"
  cat >"$source/LICENSE" <<'EOF'
MIT License
EOF
  cat >"$source/codex-skills/sample-skill/SKILL.md" <<'EOF'
---
name: sample-skill
description: Synthetic AI Berkshire sync fixture. Source: skills/sample-skill.md.
---

## Codex adapter note

This block is replaced by the shared adapter.

# Sample workflow

Run `python3 tools/sample_tool.py --help`, then use `skills/sample-skill.md`.
EOF
  cat >"$source/tools/sample_tool.py" <<'EOF'
#!/usr/bin/env python3
"""Example: python3 tools/sample_tool.py --help"""
import argparse

parser = argparse.ArgumentParser()
parser.parse_args()
EOF
  git -C "$source" init -q
  git -C "$source" config user.name pi67-test
  git -C "$source" config user.email pi67-test@example.invalid
  git -C "$source" add LICENSE codex-skills tools
  git -C "$source" commit -qm fixture
  git -C "$source" remote add origin https://github.com/xbtlin/ai-berkshire.git
  printf '%s\n' "$source"
}

expect_invalid() {
  local source="$1"
  local expected="$2"
  local label="$3"
  local output="$TMP/invalid-$pass_count.json"
  if bash "$SYNC" --source "$source" --dest-root "$TMP/invalid-dest" \
    --pack-registry "$TMP/invalid-registry.json" --pack-lock "$TMP/invalid-lock.json" \
    --dry-run --json >"$output"; then
    fail "$label accepted invalid input"
  fi
  assert_json "$output" "data.result === 'INVALID_INPUT' && data.error.includes('$expected')" "$label"
}

node --input-type=module - "$ROOT" <<'NODE' || fail "production Pack integrity"
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const integrity = await import(pathToFileURL(path.join(root, "packages/pi67-cli/src/lib/skill-pack-integrity.mjs")));
const registry = JSON.parse(fs.readFileSync(path.join(root, "shared-skill-packs.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "shared-skill-packs.lock.json"), "utf8"));
const expected = [
  "bottleneck-hunter", "deep-company-series", "dyp-ask", "earnings-review", "earnings-team",
  "financial-data", "income-investment", "industry-funnel", "industry-research", "investment-checklist",
  "investment-memo-craft", "investment-research", "investment-team", "management-deep-dive", "news-pulse",
  "portfolio-review", "private-company-research", "quality-screen", "thesis-drift", "thesis-tracker",
  "wechat-article",
];
const pack = registry.packs.find((entry) => entry.name === "ai-berkshire-investment-suite");
const locked = lock.packs.find((entry) => entry.name === pack?.name);
if (!pack || !locked || !/^\d+\.\d+\.\d+$/.test(pack.version)) throw new Error("missing production AI Berkshire Pack");
if (JSON.stringify(pack.skills) !== JSON.stringify(expected)) throw new Error("production Pack Skill set mismatch");
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(locked.source_commit)) throw new Error("invalid source commit");
if (!/^[0-9a-f]{64}$/.test(locked.manifest_sha256)) throw new Error("invalid manifest hash");
if (JSON.stringify(locked.skills.map((skill) => skill.name)) !== JSON.stringify(expected)) {
  throw new Error("lock Skill set mismatch");
}

for (const item of locked.skills) {
  const dir = path.join(root, "shared-skills", item.name);
  const skillFile = path.join(dir, "SKILL.md");
  const text = fs.readFileSync(skillFile, "utf8");
  const upstream = JSON.parse(fs.readFileSync(path.join(dir, "UPSTREAM.json"), "utf8"));
  if (integrity.hashDirectory(dir) !== item.sha256) throw new Error(`Skill hash mismatch: ${item.name}`);
  if (!text.includes("## Shared Pi/Codex adapter note")) throw new Error(`adapter missing: ${item.name}`);
  if (!text.includes("license: MIT (see LICENSE)")) throw new Error(`license metadata missing: ${item.name}`);
  if (/tools\/[A-Za-z0-9_.-]+\.py\b/.test(text)) throw new Error(`unresolved tool path: ${item.name}`);
  if (/skills\/[a-z0-9-]+\.md\b/.test(text)) throw new Error(`unresolved sibling path: ${item.name}`);
  if (/~\/ai-berkshire\b/.test(text) || /\/Users\/(?!<)[^/\s]+\//.test(text)) {
    throw new Error(`personal path remains: ${item.name}`);
  }
  if (!fs.existsSync(path.join(dir, "LICENSE"))) throw new Error(`LICENSE missing: ${item.name}`);
  if (upstream.source_commit !== locked.source_commit || upstream.pack !== pack.name) {
    throw new Error(`provenance mismatch: ${item.name}`);
  }
  const scriptsDir = path.join(dir, "scripts");
  if (fs.existsSync(scriptsDir)) {
    for (const script of fs.readdirSync(scriptsDir).filter((name) => name.endsWith(".py"))) {
      const scriptText = fs.readFileSync(path.join(scriptsDir, script), "utf8");
      if (/tools\/[A-Za-z0-9_.-]+\.py\b/.test(scriptText)) throw new Error(`unadapted script help: ${item.name}/${script}`);
    }
  }
}
if (integrity.hashSkillSet(locked.skills) !== locked.bundle_sha256) throw new Error("bundle hash mismatch");
NODE
pass "production Pack has 21 locked, adapted, provenance-complete Skills"

python3 "$ROOT/shared-skills/investment-research/scripts/financial_rigor.py" --help >/dev/null
python3 "$ROOT/shared-skills/investment-research/scripts/report_audit.py" --help >/dev/null
calc_output="$(python3 "$ROOT/shared-skills/investment-research/scripts/financial_rigor.py" calc --expr '510 * 9.11e9')"
[[ "$calc_output" == *"4646100000000.0"* ]] || fail "financial rigor exact calculation"
verdict_output="$(python3 "$ROOT/shared-skills/investment-research/scripts/report_audit.py" verdict --results '[{"id":1,"label":"revenue","reported_value":100,"unit":"billion","fetched_value":100,"fetched_source":"source-a","fetched_value2":100,"fetched_source2":"source-b"}]')"
[[ "$verdict_output" == *"PASS"* || "$verdict_output" == *"准出"* ]] || fail "report audit deterministic verdict"
pass "bundled financial tools execute deterministic smoke cases"

source="$(make_fixture valid-source)"
mkdir -p "$TMP/synthetic-dest"
printf '{"schema":"pi67.shared-skill-packs.v1","packs":[]}\n' >"$TMP/synthetic-registry.json"
printf '{"schema":"pi67.shared-skill-packs-lock.v1","packs":[]}\n' >"$TMP/synthetic-lock.json"
bash "$SYNC" --source "$source" --dest-root "$TMP/synthetic-dest" \
  --pack-registry "$TMP/synthetic-registry.json" --pack-lock "$TMP/synthetic-lock.json" \
  --apply --yes --json >"$TMP/synthetic-apply.json"
assert_json "$TMP/synthetic-apply.json" "data.result === 'APPLIED' && data.counts.applied === 1 && data.packVersion === '1.0.0'" "synthetic Pack applies"
rg -q 'python3 scripts/sample_tool.py' "$TMP/synthetic-dest/sample-skill/scripts/sample_tool.py" || fail "tool help path adaptation"
bash "$SYNC" --source "$source" --dest-root "$TMP/synthetic-dest" \
  --pack-registry "$TMP/synthetic-registry.json" --pack-lock "$TMP/synthetic-lock.json" \
  --dry-run --json >"$TMP/synthetic-noop.json"
assert_json "$TMP/synthetic-noop.json" "data.result === 'NOOP' && data.counts.identical === 1" "same source sync is idempotent"

removal_source="$(make_fixture removal-source)"
mkdir -p "$removal_source/codex-skills/legacy-skill"
cat >"$removal_source/codex-skills/legacy-skill/SKILL.md" <<'EOF'
---
name: legacy-skill
description: Synthetic removal fixture. Source: skills/legacy-skill.md.
---

# Legacy workflow
EOF
git -C "$removal_source" add codex-skills/legacy-skill/SKILL.md
git -C "$removal_source" commit -qm "add legacy Skill"
mkdir -p "$TMP/removal-dest"
printf '{"schema":"pi67.shared-skill-packs.v1","packs":[]}\n' >"$TMP/removal-registry.json"
printf '{"schema":"pi67.shared-skill-packs-lock.v1","packs":[]}\n' >"$TMP/removal-lock.json"
bash "$SYNC" --source "$removal_source" --dest-root "$TMP/removal-dest" \
  --pack-registry "$TMP/removal-registry.json" --pack-lock "$TMP/removal-lock.json" \
  --apply --yes --json >"$TMP/removal-initial.json"
git -C "$removal_source" rm -qr codex-skills/legacy-skill
git -C "$removal_source" commit -qm "remove legacy Skill"
bash "$SYNC" --source "$removal_source" --dest-root "$TMP/removal-dest" \
  --pack-registry "$TMP/removal-registry.json" --pack-lock "$TMP/removal-lock.json" \
  --apply --yes --json >"$TMP/removal-apply.json"
assert_json "$TMP/removal-apply.json" "data.result === 'APPLIED' && data.packVersion === '2.0.0' && data.counts.remove === 1" "removed upstream Skill triggers major transactional refresh"
[[ ! -e "$TMP/removal-dest/legacy-skill" ]] || fail "removed upstream Skill remains vendored"
pass "removed upstream Skill directory is removed"

dirty_source="$(make_fixture dirty-source)"
printf '\nDirty\n' >>"$dirty_source/codex-skills/sample-skill/SKILL.md"
expect_invalid "$dirty_source" "worktree must be clean" "dirty source fails closed"

wrong_origin="$(make_fixture wrong-origin)"
git -C "$wrong_origin" remote set-url origin https://github.com/example/not-ai-berkshire.git
expect_invalid "$wrong_origin" "unexpected AI Berkshire origin" "wrong origin fails closed"

missing_tool="$(make_fixture missing-tool)"
rm "$missing_tool/tools/sample_tool.py"
git -C "$missing_tool" add tools/sample_tool.py
git -C "$missing_tool" commit -qm "remove required tool"
expect_invalid "$missing_tool" "missing or invalid tool" "missing referenced tool fails closed"

symlink_source="$(make_fixture symlink-source)"
ln -s sample_tool.py "$symlink_source/tools/linked.py"
git -C "$symlink_source" add tools/linked.py
git -C "$symlink_source" commit -qm "add symlink"
expect_invalid "$symlink_source" "must not contain symlinks" "symlink input fails closed"

changed_source="$(make_fixture changed-source)"
printf '\n# Adapter change fixture\n' >>"$changed_source/codex-skills/sample-skill/SKILL.md"
git -C "$changed_source" add codex-skills/sample-skill/SKILL.md
git -C "$changed_source" commit -qm "advance source"
override_output="$TMP/invalid-version-override.json"
if bash "$SYNC" --source "$changed_source" --dest-root "$TMP/synthetic-dest" \
  --pack-registry "$TMP/synthetic-registry.json" --pack-lock "$TMP/synthetic-lock.json" \
  --pack-version 1.0.0 --dry-run --json >"$override_output"; then
  fail "version override accepted a new source commit"
fi
assert_json "$override_output" "data.result === 'INVALID_INPUT' && data.error.includes('same-commit')" "version override cannot hide upstream changes"

mkdir -p "$TMP/home"
HOME="$TMP/home" node "$CLI" --agent-dir "$ROOT" --repo-root "$ROOT" \
  skills sync-pack ai-berkshire-investment-suite --dry-run --yes --json >"$TMP/cli-dry-run.json"
assert_json "$TMP/cli-dry-run.json" "data.summary.missing === 21 && data.actions.length === 21" "CLI Pack dry-run plans 21 copies"
HOME="$TMP/home" node "$CLI" --agent-dir "$ROOT" --repo-root "$ROOT" \
  skills sync-pack ai-berkshire-investment-suite --yes --json >"$TMP/cli-apply.json"
assert_json "$TMP/cli-apply.json" "data.actions.length === 21 && data.actions.every((item) => item.action === 'copy')" "CLI Pack apply copies 21 Skills"
HOME="$TMP/home" node "$CLI" --agent-dir "$ROOT" --repo-root "$ROOT" \
  skills sync-pack ai-berkshire-investment-suite --dry-run --yes --json >"$TMP/cli-repeat.json"
assert_json "$TMP/cli-repeat.json" "data.summary.identical === 21 && data.actions.length === 21 && data.actions.every((item) => item.action === 'skip')" "CLI repeated Pack sync is a no-op"

printf '\nAI Berkshire Skill Pack tests: PASS %s / FAIL 0\n' "$pass_count"
