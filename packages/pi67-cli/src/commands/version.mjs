import { captureCommand } from "../lib/shell-runner.mjs";
import { gitStatus } from "../lib/git.mjs";
import { currentTheme } from "../lib/theme-policy.mjs";
import { keyValue, printJson } from "../lib/output.mjs";
import { platformName } from "../lib/platform.mjs";
import { readCliPackageJson, readTextIfExists } from "../lib/paths.mjs";
import { parseCommandOptions } from "../lib/args.mjs";
import path from "node:path";

export async function versionCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) {
    printVersionHelp();
    return;
  }
  const json = ctx.json || options.json;
  const pkg = readCliPackageJson();
  const git = gitStatus(ctx.repoRoot);
  const pi = captureCommand("pi", ["--version"]);
  const data = {
    schema: "pi67.version.v1",
    manager: {
      package: pkg.name,
      version: pkg.version,
    },
    distro: {
      version: readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim(),
      commit: git.commit || "",
      branch: git.branch || "",
      dirty: Boolean(git.dirty),
    },
    runtime: {
      node: process.version,
      platform: platformName(),
      pi: pi.ok ? pi.stdout.trim() || pi.stderr.trim() : "",
    },
    paths: {
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      skillsDir: ctx.skillsDir,
      packagesDir: ctx.packagesDir,
    },
    theme: currentTheme(ctx),
  };
  if (json) {
    printJson(data);
    return;
  }
  keyValue("manager", `${data.manager.package}@${data.manager.version}`);
  keyValue("pi-67 distro", data.distro.version || "unknown");
  keyValue("git", `${data.distro.commit || "unknown"}${data.distro.dirty ? " dirty" : ""}`);
  keyValue("pi", data.runtime.pi || "not found");
  keyValue("node", data.runtime.node);
  keyValue("platform", data.runtime.platform);
  keyValue("agentDir", data.paths.agentDir);
  keyValue("theme", data.theme || "unset");
}

function printVersionHelp() {
  process.stdout.write(`pi-67 version - print manager and distro versions

Usage:
  pi-67 version [--json]

Options:
  --json  Emit machine-readable version metadata.

Examples:
  pi-67 version
  pi-67 version --json
`);
}
