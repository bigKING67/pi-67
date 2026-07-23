#!/usr/bin/env bash
set -euo pipefail

# Release-readiness gate for the immutable, non-downgrading pi-67 distribution.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
CREATED_SETTINGS=false
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-release-check.XXXXXX")"

cleanup() {
  rm -rf "$TMP_ROOT"
  if [ "$CREATED_SETTINGS" = true ]; then rm -f "$REPO_ROOT/settings.json"; fi
}
trap cleanup EXIT

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}PASS${NC} $*"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); echo -e "  ${YELLOW}WARN${NC} $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo -e "  ${RED}FAIL${NC} $*"; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

run_gate() {
  local label="$1"
  shift
  if "$@" >"$TMP_ROOT/${label// /-}.log" 2>&1; then
    pass "$label"
  else
    fail "$label (see $TMP_ROOT/${label// /-}.log during this run)"
  fi
}

echo ""
echo -e "${CYAN}pi-67 release check${NC}"
echo "Repository: $REPO_ROOT"

if [ ! -f "$REPO_ROOT/settings.json" ] && [ -f "$REPO_ROOT/settings.example.json" ]; then
  cp "$REPO_ROOT/settings.example.json" "$REPO_ROOT/settings.json"
  chmod 600 "$REPO_ROOT/settings.json" 2>/dev/null || true
  CREATED_SETTINGS=true
fi

VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || true)"
if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  pass "VERSION is semver-like: $VERSION"
else
  fail "VERSION is missing or invalid: $VERSION"
fi

if command_exists node; then
  if node - "$REPO_ROOT" "$VERSION" <<'NODE'
const fs = require("fs");
const path = require("path");
const [, , root, version] = process.argv;
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rootLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const cliPackage = JSON.parse(fs.readFileSync(path.join(root, "packages/pi67-cli/package.json"), "utf8"));
if (rootPackage.version !== version || rootLock.version !== version || rootLock.packages?.[""]?.version !== version || cliPackage.version !== version) {
  throw new Error("VERSION/package/package-lock/CLI package versions differ");
}
NODE
  then
    pass "root, lock, CLI package, and distro versions match"
  else
    fail "version metadata is inconsistent"
  fi
else
  fail "node is required for release validation"
fi

if grep -q "## \[$VERSION\]" "$REPO_ROOT/CHANGELOG.md" \
  && grep -q "## \[$VERSION\]" "$REPO_ROOT/packages/pi67-cli/CHANGELOG.md" \
  && grep -q "当前发行版版本：\`$VERSION\`" "$REPO_ROOT/README.md"; then
  pass "changelogs and README identify $VERSION"
else
  fail "changelog or README release version is incomplete"
fi

required_files=(
  "packages/pi67-cli/scripts/build-distro-bundle.mjs"
  "packages/pi67-cli/scripts/clean-distro-bundle.mjs"
  "packages/pi67-cli/src/commands/migrate.mjs"
  "packages/pi67-cli/src/commands/rollback.mjs"
  "packages/pi67-cli/src/data/managed-extension-baselines.json"
  "packages/pi67-cli/src/lib/managed-extensions.mjs"
  "packages/pi67-cli/src/lib/release-store.mjs"
  "packages/pi67-cli/schemas/pi67-distro-manifest.schema.json"
  "packages/pi67-cli/schemas/pi67-update-plan.schema.json"
  "shared-skill-packs.json"
  "shared-skill-packs.lock.json"
  "scripts/pi67-bootstrap.ps1"
  "scripts/pi67-release-artifact-smoke.sh"
)
missing_required=()
for rel in "${required_files[@]}"; do
  if [ ! -e "$REPO_ROOT/$rel" ]; then missing_required+=("$rel"); fi
done
if [ "${#missing_required[@]}" -eq 0 ]; then
  pass "immutable-release, baseline, migration, schema, and release assets exist"
else
  fail "missing required release assets: ${missing_required[*]}"
fi

if [ ! -e "$REPO_ROOT/packages/pi67-cli/src/lib/upstream-pi-runtime.mjs" ] \
  && [ ! -e "$REPO_ROOT/scripts/pi67-upstream-pi-status.mjs" ]; then
  pass "obsolete Pi version-policy modules are removed"
else
  fail "obsolete Pi version-policy modules still exist"
fi

if command_exists node; then
  if node - "$REPO_ROOT" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const baseline = JSON.parse(fs.readFileSync(path.join(root, "packages/pi67-cli/src/data/managed-extension-baselines.json"), "utf8"));
if (baseline.schema !== "pi67.managed-extension-baselines.v1") throw new Error("wrong baseline schema");
if (baseline.extensions.length !== 21) throw new Error(`expected 21 defaults, got ${baseline.extensions.length}`);
const counts = baseline.extensions.reduce((out, item) => (out[item.sourceKind] = (out[item.sourceKind] || 0) + 1, out), {});
if ((counts.npm || 0) + (counts.git || 0) !== 17 || counts.bundled !== 4) throw new Error(`wrong source counts: ${JSON.stringify(counts)}`);
const byId = new Map(baseline.extensions.map((item) => [item.id, item]));
if (byId.get("pi-observational-memory")?.role !== "session-compression") throw new Error("observational memory role drifted");
if (byId.get("pi-hy-memory")?.role !== "cross-session-long-term-memory") throw new Error("Hy-Memory role drifted");
if (JSON.stringify(baseline).includes("agent_memory")) throw new Error("personal MCP entered public baseline");
for (const item of baseline.extensions) {
  if (item.sourceKind === "npm" && (!item.minimumVersion || !/^[0-9a-f]{64}$/.test(item.contentHash || ""))) throw new Error(`invalid npm baseline: ${item.id}`);
  if (item.sourceKind === "git" && (!/^[0-9a-f]{40}$/.test(item.minimumCommit || "") || !item.repoUrl)) throw new Error(`invalid Git baseline: ${item.id}`);
  if (item.sourceKind === "bundled" && (!item.bundlePath || !/^[0-9a-f]{64}$/.test(item.contentHash || ""))) throw new Error(`invalid bundled baseline: ${item.id}`);
}
NODE
  then
    pass "21 extension minimum baselines and two-layer memory roles are valid"
  else
    fail "managed extension baseline contract failed"
  fi
fi

if command_exists node; then
  if node - "$REPO_ROOT" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const registry = JSON.parse(fs.readFileSync(path.join(root, "shared-skill-packs.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "shared-skill-packs.lock.json"), "utf8"));
const expected = new Map([
  ["consumer-brand-commerce-marketing-suite", 8],
  ["ai-berkshire-investment-suite", 21],
]);
if (registry.packs.length !== 2 || lock.packs.length !== 2) throw new Error("expected two first-party packs");
for (const pack of registry.packs) {
  if (pack.owner !== "pi67-first-party" || pack.distribution !== "bundled-release-only") throw new Error(`wrong ownership: ${pack.name}`);
  if (pack.skills.length !== expected.get(pack.name)) throw new Error(`wrong skill count: ${pack.name}`);
}
const sharedRoot = path.join(root, "shared-skills");
const shared = fs.readdirSync(sharedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(sharedRoot, entry.name, "SKILL.md"))).map((entry) => entry.name);
const lark = shared.filter((name) => name.startsWith("lark-"));
if (shared.length !== 62) throw new Error(`expected 62 shared Skills, got ${shared.length}`);
if (lark.length !== 27 || !lark.includes("lark-apps") || !lark.includes("lark-note")) throw new Error(`expected 27 Lark Skills, got ${lark.length}`);
NODE
  then
    pass "62 shared Skills, 27 Lark Skills, and first-party Pack metadata are complete"
  else
    fail "shared Skill inventory or first-party Pack contract failed"
  fi
fi

if command_exists node; then
  if node - "$REPO_ROOT" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const publicJson = ["mcp.example.json", "settings.example.json"];
for (const rel of publicJson) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  if (/agent_memory/.test(text)) throw new Error(`${rel} distributes personal agent_memory`);
}
const publicData = [
  "packages/pi67-cli/src/data/distro-manifest.json",
  "packages/pi67-cli/src/data/extension-registry.json",
  "packages/pi67-cli/src/data/managed-extension-baselines.json",
];
for (const rel of publicData) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  if (/agent_memory/.test(text)) throw new Error(`${rel} distributes personal agent_memory`);
}
NODE
  then
    pass "public templates and registries exclude personal agent_memory"
  else
    fail "personal MCP leaked into public defaults"
  fi
fi

if ! grep -Eq 'pi-observational-memory.*session|session.*pi-observational-memory' "$REPO_ROOT/README.md" \
  || ! grep -Eq 'pi-hy-memory.*cross-session|cross-session.*pi-hy-memory' "$REPO_ROOT/packages/pi67-cli/README.md"; then
  fail "public documentation does not distinguish session compression from cross-session memory"
else
  pass "public documentation distinguishes both default memory layers"
fi

if grep -R -n -E 'upstreamPi|testedVersion|installedBehindTested|@earendil-works/pi-coding-agent@latest' \
  "$REPO_ROOT/packages/pi67-cli/src" "$REPO_ROOT/scripts/pi67-report.sh" "$REPO_ROOT/scripts/pi67-report.ps1" \
  "$REPO_ROOT/scripts/pi67-doctor.sh" "$REPO_ROOT/scripts/pi67-doctor.ps1" >/dev/null 2>&1; then
  fail "current runtime code still contains Pi version-management policy"
else
  pass "current runtime code has no Pi version comparison/recommendation policy"
fi

if grep -q 'commandVersion("pi"' "$REPO_ROOT/scripts/pi67-report.sh" \
  || grep -q 'Get-CommandVersion "pi"' "$REPO_ROOT/scripts/pi67-report.ps1" \
  || grep -q 'pi-version' "$REPO_ROOT/scripts/pi67-bootstrap.ps1"; then
  fail "report/bootstrap still queries the Pi version"
else
  pass "report/bootstrap check only Pi command availability"
fi

if grep -Fq 'runCommand("pi"' "$REPO_ROOT/packages/pi67-cli/src/commands/update.mjs" \
  || grep -Fq 'captureCommand("pi"' "$REPO_ROOT/packages/pi67-cli/src/commands/update.mjs"; then
  fail "pi-67 update invokes the independent Pi runtime"
else
  pass "pi-67 update does not mutate or version-probe Pi"
fi

if grep -q 'git clone https://github.com/bigKING67/pi-67' "$REPO_ROOT/README.md" "$REPO_ROOT/packages/pi67-cli/README.md" "$REPO_ROOT/docs/full-install.md" "$REPO_ROOT/docs/windows-fresh-install.md" \
  || grep -q 'pi update --extensions' "$REPO_ROOT/README.md" "$REPO_ROOT/packages/pi67-cli/README.md" "$REPO_ROOT/docs/full-install.md" "$REPO_ROOT/docs/windows-fresh-install.md"; then
  fail "current install/update docs still recommend the legacy mutable workspace path"
else
  pass "current install/update docs use manager-bundled immutable releases"
fi

if grep -q 'deprecated compatibility updater for a legacy Git source checkout' "$REPO_ROOT/scripts/pi67-update.sh" \
  && grep -q 'Deprecated PowerShell compatibility updater for legacy Git source checkouts' "$REPO_ROOT/scripts/pi67-update.ps1"; then
  pass "legacy Git updaters are explicitly scoped as compatibility-only"
else
  fail "legacy Git updater scope is ambiguous"
fi

if grep -q 'pi-67 migrate --check' "$REPO_ROOT/README.md" \
  && grep -q 'pi-67 rollback --migration --yes' "$REPO_ROOT/docs/full-install.md" \
  && grep -q 'pending-activation.json' "$REPO_ROOT/docs/troubleshooting.md" \
  && grep -q 'Trusted Publishing' "$REPO_ROOT/docs/release.md"; then
  pass "migration, rollback, interrupted activation, and release docs are present"
else
  fail "immutable release lifecycle documentation is incomplete"
fi

if grep -q 'pi67-report/v2' "$REPO_ROOT/docs/report-schema.md" \
  && grep -q 'piCommandAvailable' "$REPO_ROOT/docs/report-schema.md" \
  && grep -q 'pi67-doctor/v2' "$REPO_ROOT/docs/doctor-schema.md" \
  && grep -q 'pi67.update-plan.v1' "$REPO_ROOT/docs/status.md" \
  && grep -q 'loadFailed' "$REPO_ROOT/docs/status.md"; then
  pass "report, doctor, and update-plan schemas are documented"
else
  fail "current schema documentation is incomplete"
fi

run_gate "CLI package self-tests and packed artifact gate" node "$REPO_ROOT/packages/pi67-cli/scripts/check.mjs"
run_gate "prompt governance" node "$REPO_ROOT/scripts/pi67-prompt-governance-check.mjs"
if [ "${PI67_SKIP_RULES_LOADER_TEST:-0}" = "1" ]; then
  warn "rules loader tests skipped for dependency-free artifact inspection"
else
  run_gate "rules loader tests" npm --prefix "$REPO_ROOT" run -s test:rules-loader
fi
if [ "${PI67_SKIP_VISION_BRIDGE_TEST:-0}" = "1" ]; then
  warn "vision bridge registration tests skipped for dependency-free artifact inspection"
else
  run_gate "vision bridge registration tests" npm --prefix "$REPO_ROOT" run -s test:vision-bridge
fi

if [ -f "$REPO_ROOT/npm/node_modules/typescript/bin/tsc" ]; then
  run_gate "xtalpi TypeScript check" npm --prefix "$REPO_ROOT" run -s typecheck:xtalpi
  run_gate "Hy-Memory TypeScript check" npm --prefix "$REPO_ROOT" run -s typecheck:hy-memory
  run_gate "Hy-Memory tests" npm --prefix "$REPO_ROOT" run -s test:hy-memory
else
  warn "runtime TypeScript dependencies are missing; skipped TypeScript/Hy-Memory test gates"
fi

run_gate "shared Skill governance tests" bash "$REPO_ROOT/scripts/pi67-test-skill-governance.sh"

if command_exists bash; then
  if bash -n \
    "$REPO_ROOT/scripts/pi67-doctor.sh" \
    "$REPO_ROOT/scripts/pi67-report.sh" \
    "$REPO_ROOT/scripts/pi67-update.sh" \
    "$REPO_ROOT/scripts/pi67-release.sh" \
    "$REPO_ROOT/scripts/pi67-release-artifact-smoke.sh"; then
    pass "release-critical shell scripts parse"
  else
    fail "release-critical shell syntax failed"
  fi
fi

if command_exists pwsh; then
  run_gate "Windows bootstrap self-test" pwsh -NoProfile -File "$REPO_ROOT/scripts/pi67-bootstrap.ps1" -SelfTest
else
  warn "pwsh is unavailable; Windows bootstrap source contract checked but native self-test was not run"
fi

if command_exists node; then
  MANIFEST_JSON="$TMP_ROOT/manifest.json"
  UPDATE_JSON="$TMP_ROOT/update-plan.json"
  if node "$REPO_ROOT/packages/pi67-cli/bin/pi-67.mjs" \
      --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" --skills-dir "$REPO_ROOT/shared-skills" \
      --no-remote manifest --json >"$MANIFEST_JSON" \
    && node "$REPO_ROOT/packages/pi67-cli/bin/pi-67.mjs" \
      --agent-dir "$REPO_ROOT" --repo-root "$REPO_ROOT" --skills-dir "$REPO_ROOT/shared-skills" \
      --no-remote update --check --json >"$UPDATE_JSON"; then
    pass "real manifest and update-plan JSON generated"
  else
    fail "real manifest/update-plan JSON generation failed"
  fi

  if command_exists python3 && python3 -c 'import jsonschema' >/dev/null 2>&1; then
    if python3 - "$REPO_ROOT" "$MANIFEST_JSON" "$UPDATE_JSON" <<'PY'
import json
import pathlib
import sys
from jsonschema import Draft202012Validator

root = pathlib.Path(sys.argv[1])
pairs = [
    (root / "packages/pi67-cli/schemas/pi67-distro-manifest.schema.json", pathlib.Path(sys.argv[2])),
    (root / "packages/pi67-cli/schemas/pi67-update-plan.schema.json", pathlib.Path(sys.argv[3])),
]
for schema_path, payload_path in pairs:
    schema = json.loads(schema_path.read_text())
    payload = json.loads(payload_path.read_text())
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(payload)
PY
    then
      pass "Draft 2020-12 schemas validate real CLI payloads"
    else
      fail "schema validation of real CLI payloads failed"
    fi
  else
    warn "python jsonschema is unavailable; schema files were parsed by package self-tests only"
  fi
fi

REPORT_JSON="$TMP_ROOT/report.json"
if bash "$REPO_ROOT/scripts/pi67-report.sh" --repo-root "$REPO_ROOT" --agent-dir "$REPO_ROOT" \
  --skills-dir "$REPO_ROOT/shared-skills" --no-doctor --no-xtalpi-smoke --output "$REPORT_JSON" >/dev/null 2>&1 \
  && node -e 'const r=require(process.argv[1]); if ("pi" in (r.runtime||{})) process.exit(1); if (typeof r.runtime?.piCommandAvailable!=="boolean") process.exit(1)' "$REPORT_JSON"; then
  pass "report v2 exposes Pi command availability without Pi version"
else
  fail "report v2 Pi independence contract failed"
fi

if command_exists git && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$REPO_ROOT" diff --check >/dev/null; then pass "git diff --check passed"; else fail "git diff --check failed"; fi
  untracked_release_assets=()
  for rel in "${required_files[@]}"; do
    if ! git -C "$REPO_ROOT" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then untracked_release_assets+=("$rel"); fi
  done
  if [ "${#untracked_release_assets[@]}" -eq 0 ]; then
    pass "new release assets are tracked or staged"
  else
    warn "new release assets are not all staged yet: ${untracked_release_assets[*]}"
  fi
else
  warn "git is unavailable; skipped diff/tracked-scope checks"
fi

echo ""
echo -e "${CYAN}Summary${NC}"
echo "  PASS: $PASS_COUNT"
echo "  WARN: $WARN_COUNT"
echo "  FAIL: $FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}Result: FAIL${NC}"
  exit 1
fi
if [ "$WARN_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}Result: PASS WITH WARNINGS${NC}"
else
  echo -e "${GREEN}Result: PASS${NC}"
fi
