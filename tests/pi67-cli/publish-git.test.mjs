import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  gitReleaseStatus,
  gitStatus,
  parseGitStatusPorcelain,
} from "../../packages/pi67-cli/src/lib/git.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "packages", "pi67-cli", "bin", "pi-67.mjs");

test("Git porcelain parser preserves status entries and normalizes branch headers", () => {
  assert.deepEqual(parseGitStatusPorcelain("## main...origin/main [ahead 1]\n M tracked.txt\n?? new.txt\n"), {
    branchLine: "## main...origin/main [ahead 1]",
    branch: "main",
    short: " M tracked.txt\n?? new.txt",
  });
  assert.equal(parseGitStatusPorcelain("## HEAD (no branch)\n").branch, "");
  assert.equal(parseGitStatusPorcelain("## No commits yet on trunk\n").branch, "trunk");
  assert.equal(parseGitStatusPorcelain("## Initial commit on legacy\r\n").branch, "legacy");
});

test("gitStatus handles clean, dirty, detached, and non-repository roots", (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const clean = gitStatus(fixture.work);
  assert.equal(clean.isRepo, true);
  assert.equal(clean.dirty, false);
  assert.equal(clean.branch, "main");
  assert.match(clean.commit, /^[0-9a-f]{12}$/);
  assert.match(clean.headCommit, /^[0-9a-f]{40}$/);

  fs.writeFileSync(path.join(fixture.work, "dirty.txt"), "dirty\n");
  const dirty = gitStatus(fixture.work);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.short, "?? dirty.txt");
  fs.rmSync(path.join(fixture.work, "dirty.txt"));

  git(fixture.work, ["switch", "-q", "--detach", "HEAD"]);
  assert.equal(gitStatus(fixture.work).branch, "");

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-not-git-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(gitStatus(outside), {
    ok: false,
    isRepo: false,
    dirty: false,
    short: "",
    branchLine: "",
    branch: "",
    commit: "",
    headCommit: "",
    remote: "",
  });
});

test("publish Git contract accepts only a clean exact main checkout", (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const clean = gitReleaseStatus(fixture.work, { verifyRemote: true });
  assert.equal(clean.ready, true, clean.problems.join("; "));
  assert.equal(clean.headCommit, clean.remoteTrackingCommit);
  assert.equal(clean.headCommit, clean.liveRemote.commit);

  fs.writeFileSync(path.join(fixture.work, "dirty.txt"), "dirty\n");
  const dirty = gitReleaseStatus(fixture.work, { verifyRemote: false });
  assert.equal(dirty.ready, false);
  assert.ok(dirty.problems.includes("repo has local changes"));
  fs.rmSync(path.join(fixture.work, "dirty.txt"));

  git(fixture.work, ["switch", "-q", "-c", "feature"]);
  const feature = gitReleaseStatus(fixture.work, { verifyRemote: false });
  assert.equal(feature.ready, false);
  assert.match(feature.problems.join("; "), /release branch must be main/);

  git(fixture.work, ["switch", "-q", "main"]);
  git(fixture.work, ["switch", "-q", "--detach", "HEAD"]);
  const detached = gitReleaseStatus(fixture.work, { verifyRemote: false });
  assert.equal(detached.ready, false);
  assert.ok(detached.problems.includes("HEAD is detached"));
});

test("publish Git contract rejects a main branch ahead of origin/main", (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.work, "ahead.txt"), "ahead\n");
  git(fixture.work, ["add", "ahead.txt"]);
  git(fixture.work, ["commit", "-q", "-m", "ahead"]);

  const ahead = gitReleaseStatus(fixture.work, { verifyRemote: false });
  assert.equal(ahead.ready, false);
  assert.ok(ahead.problems.includes("HEAD does not match origin/main"));
});

test("publish Git contract rejects a main branch behind origin/main", (t) => {
  const fixture = createGitFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.seed, "remote-ahead.txt"), "remote ahead\n");
  git(fixture.seed, ["add", "remote-ahead.txt"]);
  git(fixture.seed, ["commit", "-q", "-m", "remote ahead"]);
  git(fixture.seed, ["push", "-q", "origin", "main"]);
  git(fixture.work, ["fetch", "-q", "origin", "main"]);

  const behind = gitReleaseStatus(fixture.work, { verifyRemote: false });
  assert.equal(behind.ready, false);
  assert.ok(behind.problems.includes("HEAD does not match origin/main"));
});

test("publish-check --strict enforces the Git release contract", (t) => {
  const fixture = createPublishRepoFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const clean = runPublishCheck(fixture.work);
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  const cleanReport = JSON.parse(clean.stdout);
  assert.equal(cleanReport.blockers.length, 0);
  assert.equal(cleanReport.exactVersion?.skipped, true);

  fs.writeFileSync(path.join(fixture.work, "dirty.txt"), "dirty\n");
  assertPublishCheckBlocked(fixture.work, /repo has local changes/);
  fs.rmSync(path.join(fixture.work, "dirty.txt"));

  git(fixture.work, ["switch", "-q", "-c", "feature"]);
  assertPublishCheckBlocked(fixture.work, /release branch must be main/);

  git(fixture.work, ["switch", "-q", "main"]);
  git(fixture.work, ["switch", "-q", "--detach", "HEAD"]);
  assertPublishCheckBlocked(fixture.work, /HEAD is detached/);

  git(fixture.work, ["switch", "-q", "main"]);
  fs.writeFileSync(path.join(fixture.work, "ahead.txt"), "ahead\n");
  git(fixture.work, ["add", "ahead.txt"]);
  git(fixture.work, ["commit", "-q", "-m", "ahead"]);
  assertPublishCheckBlocked(fixture.work, /HEAD does not match origin\/main/);
});

test("publish workflow keeps one full smoke gate and fails closed before npm publish", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "npm-publish.yml"), "utf8");
  const cliPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "pi67-cli", "package.json"), "utf8"));
  const smoke = fs.readFileSync(path.join(repoRoot, "scripts", "pi67-smoke.sh"), "utf8");

  assert.match(workflow, /actions: read/);
  assert.match(workflow, /GITHUB_REF[^\n]+refs\/heads\/main/);
  assert.match(workflow, /HEAD does not match origin\/main/);
  assert.match(workflow, /head_sha=\$GITHUB_SHA/);
  assert.match(workflow, /required ci workflow did not succeed/);
  assert.match(workflow, /npm --prefix npm ci --omit=peer --ignore-scripts/);
  assert.match(workflow, /VERSION_ALREADY_PUBLISHED/);
  assert.match(workflow, /if: \$\{\{ !inputs\.dry_run && steps\.npm_version\.outputs\.published != 'true' \}\}/);
  assert.equal((workflow.match(/bash scripts\/pi67-smoke\.sh --ci/g) || []).length, 1);
  assert.doesNotMatch(workflow, /Run npm manager checks|Run release metadata check|Pack npm manager/);

  assert.equal(cliPackage.engines?.node, ">=22.19.0");
  assert.match(cliPackage.scripts?.prepublishOnly || "", /publish-check --quiet --strict --no-pack --no-remote/);
  assert.doesNotMatch(cliPackage.scripts?.prepublishOnly || "", /scripts\/check\.mjs/);
  assert.match(smoke, /pi67-release-artifact-smoke\.sh/);
});

test("GitHub workflows pin external Actions to immutable commit SHAs", () => {
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const workflowFiles = fs.readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  let actionCount = 0;

  for (const name of workflowFiles) {
    const source = fs.readFileSync(path.join(workflowDir, name), "utf8");
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!/\buses:\s+actions\//.test(line)) continue;
      actionCount += 1;
      assert.match(
        line,
        /\buses:\s+actions\/[A-Za-z0-9._-]+@[0-9a-f]{40}\s+#\s+v\d+\s*$/,
        `${name}:${index + 1} must pin the Action to a full commit SHA with a version comment`,
      );
    }
  }

  assert.ok(actionCount > 0, "workflow Action pinning contract did not inspect any Actions");
});

test("CLI entrypoint reports failures without forcing libuv shutdown", () => {
  const entrypoint = fs.readFileSync(cli, "utf8");

  assert.match(entrypoint, /process\.exitCode = error\.exitCode/);
  assert.match(entrypoint, /process\.exitCode = 1/);
  assert.doesNotMatch(entrypoint, /process\.exit\s*\(/);
});

function createGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-publish-git-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const work = path.join(root, "work");
  git(root, ["init", "--bare", "-q", remote]);
  git(root, ["init", "-q", "-b", "main", seed]);
  git(seed, ["config", "user.name", "pi67 publish test"]);
  git(seed, ["config", "user.email", "pi67-publish@example.invalid"]);
  fs.writeFileSync(path.join(seed, "VERSION"), "0.0.0-test\n");
  git(seed, ["add", "VERSION"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["clone", "-q", remote, work]);
  git(work, ["config", "user.name", "pi67 publish test"]);
  git(work, ["config", "user.email", "pi67-publish@example.invalid"]);
  return { root, remote, seed, work };
}

function createPublishRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-publish-check-"));
  const work = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  git(root, ["clone", "-q", "--no-hardlinks", repoRoot, work]);
  git(work, ["config", "user.name", "pi67 publish test"]);
  git(work, ["config", "user.email", "pi67-publish@example.invalid"]);

  const workflowPath = path.join(".github", "workflows", "npm-publish.yml");
  fs.copyFileSync(path.join(repoRoot, workflowPath), path.join(work, workflowPath));
  git(work, ["add", workflowPath]);
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: work, encoding: "utf8" });
  assert.ok([0, 1].includes(staged.status), staged.stderr || staged.stdout);
  if (staged.status === 1) git(work, ["commit", "-q", "-m", "publish workflow fixture"]);

  git(root, ["init", "--bare", "-q", remote]);
  git(work, ["remote", "set-url", "origin", remote]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote, work };
}

function runPublishCheck(work) {
  return spawnSync(process.execPath, [
    cli,
    "--agent-dir", work,
    "--repo-root", work,
    "--skills-dir", path.join(work, "shared-skills"),
    "--no-remote",
    "publish-check",
    "--strict",
    "--json",
    "--no-pack",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function assertPublishCheckBlocked(work, messagePattern) {
  const result = runPublishCheck(work);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.match(report.blockers.join("; "), messagePattern);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
