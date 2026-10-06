import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { EXTERNAL_REPOS, externalPath, installExternal, updateExternal } from "../../packages/pi67-cli/src/lib/external-repos.mjs";
import { setupBrowser67 } from "../../packages/pi67-cli/src/lib/browser67-runtime.mjs";

test("external installs share craft67 while preserving legacy checkouts and dirty WIP", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-monorepo-"));
  const remote = path.join(temp, "remote");
  const ctx = { packagesDir: path.join(temp, "managed"), stateDir: path.join(temp, "state"), agentDir: path.join(temp, "agent") };
  const original = Object.fromEntries(Object.entries(EXTERNAL_REPOS).map(([id, spec]) => [id, spec.repoUrl]));
  const git = (...args) => execFileSync("git", ["-C", remote, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    fs.mkdirSync(remote);
    git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    for (const id of Object.keys(original)) {
      // Git normalizes Windows local paths; a file URL preserves the source contract.
      EXTERNAL_REPOS[id].repoUrl = pathToFileURL(remote).href;
      const dir = path.join(remote, "packages", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: id }));
    }
    git("add", "packages"); git("commit", "-m", "initial");
    const old = path.join(ctx.packagesDir, "browser67", "user-work.txt");
    fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, "keep");
    const dry = installExternal(ctx, "browser67", { dryRun: true, quiet: true });
    assert.equal(dry.action, "clone-dry-run");
    assert.equal(fs.existsSync(path.join(ctx.packagesDir, "craft67")), false);
    const first = installExternal(ctx, "browser67", { quiet: true });
    assert.equal(first.action, "clone");
    assert.equal(first.status.path, path.join(ctx.packagesDir, "craft67", "packages", "browser67"));
    assert.equal(installExternal(ctx, "design-craft", { quiet: true }).action, "skip");
    assert.equal(fs.readFileSync(old, "utf8"), "keep");
    const plan = setupBrowser67(ctx, { dryRun: true, quiet: true });
    assert.equal(plan.root, externalPath(ctx, "browser67"));
    const wip = path.join(externalPath(ctx, "design-craft"), "uncommitted.txt");
    fs.writeFileSync(wip, "preserve");
    assert.throws(() => updateExternal(ctx, "browser67", { quiet: true }), /dirty/);
    assert.equal(fs.readFileSync(wip, "utf8"), "preserve");
    fs.unlinkSync(wip);
    fs.writeFileSync(path.join(remote, "packages", "browser67", "new.txt"), "next");
    git("add", "packages/browser67/new.txt"); git("commit", "-m", "next");
    assert.equal(updateExternal(ctx, "browser67", { quiet: true }).changed, true);
    assert.equal(fs.readFileSync(path.join(externalPath(ctx, "browser67"), "new.txt"), "utf8"), "next");
    execFileSync("git", ["-C", first.status.checkoutPath, "remote", "set-url", "origin", "https://example.invalid/wrong.git"]);
    assert.throws(() => updateExternal(ctx, "browser67", { quiet: true }), /expected craft67/);
  } finally {
    for (const [id, url] of Object.entries(original)) EXTERNAL_REPOS[id].repoUrl = url;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
