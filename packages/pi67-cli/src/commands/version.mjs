import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { currentTheme } from "../lib/theme-policy.mjs";
import { platformName } from "../lib/platform.mjs";
import { readCliPackageJson, readTextIfExists } from "../lib/paths.mjs";
import { readCurrentRelease } from "../lib/release-store.mjs";
import { info, keyValue, printJson, section, warn } from "../lib/output.mjs";

export function versionCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printVersionHelp();
  const pkg = readCliPackageJson();
  const release = readCurrentRelease(ctx);
  const repoVersion = readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim();
  const distroVersion = release?.version || repoVersion;
  const data = {
    schema: "pi67.version.v2",
    manager: { package: pkg.name, version: pkg.version },
    distro: {
      version: distroVersion,
      releasePath: release?.releasePath || "",
      immutable: Boolean(release),
    },
    runtime: { node: process.version, platform: platformName() },
    paths: {
      agentDir: ctx.agentDir,
      stateDir: ctx.stateDir,
      repoRoot: ctx.repoRoot,
      skillsDir: ctx.skillsDir,
      packagesDir: ctx.packagesDir,
    },
    theme: currentTheme(ctx),
  };
  data.recommendations = buildVersionRecommendations(ctx, data);
  if (ctx.json || options.json) return printJson(data);
  keyValue("manager", `${data.manager.package}@${data.manager.version}`);
  keyValue("pi-67 distro", data.distro.version || "not activated");
  keyValue("release layout", data.distro.immutable ? data.distro.releasePath : "legacy/source checkout");
  keyValue("node", data.runtime.node);
  keyValue("platform", data.runtime.platform);
  keyValue("agentDir", data.paths.agentDir);
  keyValue("stateDir", data.paths.stateDir);
  keyValue("theme", data.theme || "unset");
  printRecommendations(data.recommendations);
}
function buildVersionRecommendations(ctx, data) {
  if (!data.distro.version) {
    return [{ level: "INFO", message: "Run: pi-67 install" }];
  }
  if (data.manager.version !== data.distro.version) {
    return [{
      level: "WARN",
      message: `manager ${data.manager.version} and active distro ${data.distro.version} differ; run: pi-67 --agent-dir "${ctx.agentDir}" update`,
    }];
  }
  if (!data.distro.immutable) {
    return [{ level: "INFO", message: "Preview immutable release migration with: pi-67 migrate --check" }];
  }
  return [];
}

function printRecommendations(recommendations) {
  if (!recommendations.length) return;
  section("Next steps");
  for (const item of recommendations) {
    if (item.level === "WARN") warn(item.message);
    else info(item.message);
  }
}

function printVersionHelp() {
  process.stdout.write(`pi-67 version - print pi-67 manager and distro versions

Usage:
  pi-67 version [--json]

This command intentionally does not inspect or compare the independent Pi
runtime version.
`);
}
