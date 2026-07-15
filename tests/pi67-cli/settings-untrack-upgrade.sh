#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-settings-upgrade-test.XXXXXX")"
REMOTE_REPO="$TMP_ROOT/remote.git"
SEED_REPO="$TMP_ROOT/seed"
LEGACY_UPDATER="$TMP_ROOT/pi67-update-v0.11.7.sh"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

copy_runtime_migration_sources() {
  local target="$1"
  mkdir -p "$target/packages/pi67-cli/src" "$target/packages/pi67-cli/src/tools"
  cp -R "$REPO_ROOT/packages/pi67-cli/src/lib" "$target/packages/pi67-cli/src/"
  cp "$REPO_ROOT/packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs" \
    "$target/packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs"
}

run_upgrade_case() {
  local name="$1"
  local provider="$2"
  local work="$TMP_ROOT/$name"
  local home="$TMP_ROOT/$name-home"
  local skills="$TMP_ROOT/$name-skills"
  local output="$TMP_ROOT/$name.log"

  git clone -q "$REMOTE_REPO" "$work"
  git -C "$work" checkout -q "$OLD_COMMIT"
  git -C "$work" switch -q -c "$name"
  git -C "$work" branch --set-upstream-to=origin/main >/dev/null
  if [ "$provider" != "xtalpi-pi-tools" ]; then
    node - "$work/settings.json" "$provider" <<'NODE'
const fs = require("fs");
const [file, provider] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
data.defaultProvider = provider;
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
NODE
  fi

  mkdir -p "$home" "$skills"
  HOME="$home" bash "$work/scripts/pi67-update.sh" \
    --repo-root "$work" \
    --agent-dir "$work" \
    --skills-dir "$skills" \
    --branch main \
    --no-npm \
    --no-configure \
    --no-doctor \
    --no-report > "$output" 2>&1 \
    || fail "$name upgrade failed: $(tail -n 80 "$output")"

  [ "$(git -C "$work" rev-parse HEAD)" = "$NEW_COMMIT" ] || fail "$name did not reach the migration commit"
  git -C "$work" ls-files --error-unmatch settings.json >/dev/null 2>&1 \
    && fail "$name still tracks settings.json"
  git -C "$work" ls-files --error-unmatch settings.example.json >/dev/null 2>&1 \
    || fail "$name is missing the tracked settings template"
  git -C "$work" check-ignore -q settings.json || fail "$name settings.json is not ignored"
  [ -f "$work/settings.json" ] || fail "$name settings.json was not preserved or recreated"
  node - "$work/settings.json" "$provider" <<'NODE'
const fs = require("fs");
const [file, expected] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.defaultProvider !== expected) {
  throw new Error(`provider changed during migration: ${data.defaultProvider} != ${expected}`);
}
NODE
  [ -z "$(git -C "$work" status --short)" ] || fail "$name repo is dirty after migration: $(git -C "$work" status --short)"
  if git -C "$work" config --local --get-regexp '^filter\.pi67-settings-runtime-state\.' >/dev/null 2>&1; then
    fail "$name retained the legacy settings Git filter"
  fi
}

git -C "$REPO_ROOT" show v0.11.7:scripts/pi67-update.sh > "$LEGACY_UPDATER" \
  || fail "v0.11.7 tag is required for the settings migration compatibility test"
chmod +x "$LEGACY_UPDATER"

git init --bare -q "$REMOTE_REPO"
git init -q -b main "$SEED_REPO"
git -C "$SEED_REPO" config user.email "pi67-settings-test@example.invalid"
git -C "$SEED_REPO" config user.name "pi67 settings upgrade test"
printf '0.11.7\n' > "$SEED_REPO/VERSION"
printf 'settings.json text eol=lf filter=pi67-settings-runtime-state\n' > "$SEED_REPO/.gitattributes"
printf 'models.json\nauth.json\nmcp.json\nimage-gen.json\n' > "$SEED_REPO/.gitignore"
git -C "$REPO_ROOT" show v0.11.7:settings.json > "$SEED_REPO/settings.json"
mkdir -p "$SEED_REPO/scripts"
cp "$LEGACY_UPDATER" "$SEED_REPO/scripts/pi67-update.sh"
chmod +x "$SEED_REPO/scripts/pi67-update.sh"
git -C "$SEED_REPO" add .gitattributes .gitignore VERSION settings.json scripts/pi67-update.sh
git -C "$SEED_REPO" commit -q -m "legacy tracked settings"
OLD_COMMIT="$(git -C "$SEED_REPO" rev-parse HEAD)"
git -C "$SEED_REPO" remote add origin "$REMOTE_REPO"
git -C "$SEED_REPO" push -q -u origin main
git --git-dir="$REMOTE_REPO" symbolic-ref HEAD refs/heads/main

git -C "$SEED_REPO" rm -q settings.json
cp "$REPO_ROOT/.gitignore" "$SEED_REPO/.gitignore"
cp "$REPO_ROOT/.gitattributes" "$SEED_REPO/.gitattributes"
cp "$REPO_ROOT/settings.example.json" "$SEED_REPO/settings.example.json"
for template in models.example.json mcp.example.json auth.example.json image-gen.example.json; do
  cp "$REPO_ROOT/$template" "$SEED_REPO/$template"
done
copy_runtime_migration_sources "$SEED_REPO"
mkdir -p "$SEED_REPO/shared-skills/migration-fixture"
printf '# Migration fixture\n' > "$SEED_REPO/shared-skills/migration-fixture/SKILL.md"
git -C "$SEED_REPO" add .gitattributes .gitignore settings.example.json models.example.json mcp.example.json auth.example.json image-gen.example.json packages shared-skills
git -C "$SEED_REPO" commit -q -m "migrate settings to ignored runtime"
NEW_COMMIT="$(git -C "$SEED_REPO" rev-parse HEAD)"
git -C "$SEED_REPO" push -q origin main

run_upgrade_case clean-default xtalpi-pi-tools
run_upgrade_case dirty-provider deepseek

printf 'PASS settings.json tracked-to-ignored upgrade compatibility\n'
