#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UPDATER="$REPO_ROOT/scripts/pi67-update.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi67-update-branch-test.XXXXXX")"
REMOTE_REPO="$TMP_ROOT/remote.git"
SEED_REPO="$TMP_ROOT/seed"
WORK_REPO="$TMP_ROOT/work"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

run_check() {
  local name="$1"
  local expected_source="$2"
  shift 2
  local output="$TMP_ROOT/$name.log"

  HOME="$TMP_ROOT/home" bash "$UPDATER" \
    --repo-root "$WORK_REPO" \
    --agent-dir "$WORK_REPO" \
    --check-only \
    --no-npm \
    --no-configure \
    --no-doctor \
    --no-report \
    "$@" > "$output" 2>&1 \
    || fail "$name unexpectedly failed: $(sed -n '1,20p' "$output")"

  grep -F "Target branch:" "$output" >/dev/null || fail "$name did not report a target branch"
  grep -F "$expected_source" "$output" >/dev/null || fail "$name did not report source: $expected_source"
}

run_failure() {
  local name="$1"
  local expected="$2"
  shift 2
  local output="$TMP_ROOT/$name.log"

  set +e
  HOME="$TMP_ROOT/home" bash "$UPDATER" \
    --repo-root "$WORK_REPO" \
    --agent-dir "$WORK_REPO" \
    --check-only \
    --no-npm \
    --no-configure \
    --no-doctor \
    --no-report \
    "$@" > "$output" 2>&1
  local rc=$?
  set -e

  [ "$rc" -ne 0 ] || fail "$name unexpectedly succeeded"
  grep -F "$expected" "$output" >/dev/null || fail "$name did not report: $expected"
}

git init --bare -q "$REMOTE_REPO"
git init -q -b main "$SEED_REPO"
git -C "$SEED_REPO" config user.email "pi67-update-test@example.invalid"
git -C "$SEED_REPO" config user.name "pi67 update branch test"
printf '0.0.0-test\n' > "$SEED_REPO/VERSION"
printf '{"name":"pi67-update-branch-test","version":"0.0.0-test"}\n' > "$SEED_REPO/package.json"
git -C "$SEED_REPO" add VERSION package.json
git -C "$SEED_REPO" commit -q -m "seed"
git -C "$SEED_REPO" remote add origin "$REMOTE_REPO"
git -C "$SEED_REPO" push -q -u origin main
git --git-dir="$REMOTE_REPO" symbolic-ref HEAD refs/heads/main
git clone -q "$REMOTE_REPO" "$WORK_REPO"
git -C "$WORK_REPO" config user.email "pi67-update-test@example.invalid"
git -C "$WORK_REPO" config user.name "pi67 update branch test"

run_check "upstream-main" "upstream origin/main"

git -C "$WORK_REPO" switch -q -c local-equivalent
run_check "default-equivalent" "remote default equivalence"

git -C "$WORK_REPO" switch -q main
git -C "$WORK_REPO" switch -q -c upstream-mapped
git -C "$WORK_REPO" branch --set-upstream-to=origin/main >/dev/null
run_check "upstream-mapped" "upstream origin/main"

git -C "$WORK_REPO" switch -q main
git -C "$WORK_REPO" switch -q -c published-feature
git -C "$WORK_REPO" push -q -u origin published-feature
git -C "$WORK_REPO" branch --unset-upstream
run_check "matching-feature" "matching remote branch origin/published-feature"

git -C "$WORK_REPO" switch -q main
git -C "$WORK_REPO" switch -q -c divergent
printf 'local-only\n' > "$WORK_REPO/local-only.txt"
git -C "$WORK_REPO" add local-only.txt
git -C "$WORK_REPO" commit -q -m "local only"
run_failure "divergent-no-target" "has no usable origin branch"
run_check "divergent-explicit" "explicit --branch" --branch main

git -C "$WORK_REPO" switch -q --detach main
run_failure "detached-no-target" "detached HEAD; pass --branch explicitly"
run_check "detached-explicit" "explicit --branch" --branch main

printf 'PASS updater branch resolution matrix\n'
