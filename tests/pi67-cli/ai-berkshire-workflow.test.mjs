import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(repoRoot, ".github/workflows/ai-berkshire-refresh.yml");

test("AI Berkshire refresh rebuilds its machine-owned branch from current main", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /git switch -C "\$REFRESH_BRANCH" origin\/main/);
  assert.match(workflow, /REMOTE_REFRESH_BRANCH_SHA=\$remote_branch_sha/);
  assert.match(
    workflow,
    /--force-with-lease="refs\/heads\/\$REFRESH_BRANCH:\$REMOTE_REFRESH_BRANCH_SHA"/,
  );
  assert.doesNotMatch(workflow, /git merge --no-edit origin\/main/);
  assert.doesNotMatch(workflow, /git push[^\n]*--force(?:\s|$)/);
});

test("AI Berkshire refresh degrades only the known repository PR permission failure", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(
    workflow,
    /GitHub Actions is not permitted to create or approve pull requests/,
  );
  assert.match(workflow, /Manual pull request required/);
  assert.match(workflow, /else\n\s+echo "\$pr_create_output" >&2\n\s+exit 1/);
  assert.match(workflow, /does not auto-merge, publish npm, create tags, or create releases/);
});
