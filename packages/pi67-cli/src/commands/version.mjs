import { gitStatus } from "../lib/git.mjs";
import { currentTheme } from "../lib/theme-policy.mjs";
import { info, keyValue, printJson, section, warn } from "../lib/output.mjs";
import { platformName } from "../lib/platform.mjs";
import { readCliPackageJson, readTextIfExists } from "../lib/paths.mjs";
import { readJsonFileIfExists } from "../lib/config-json.mjs";
import { parseCommandOptions } from "../lib/args.mjs";
import { inspectUpstreamPiRuntime } from "../lib/upstream-pi-runtime.mjs";
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
  const upstreamPi = await inspectUpstreamPiRuntime(ctx, { noRemote: ctx.noRemote });
  const distroVersion = readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim();
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const data = {
    schema: "pi67.version.v1",
    manager: {
      package: pkg.name,
      version: pkg.version,
    },
    distro: {
      version: distroVersion,
      commit: git.commit || "",
      branch: git.branch || "",
      dirty: Boolean(git.dirty),
    },
    runtime: {
      node: process.version,
      platform: platformName(),
      pi: upstreamPi.installedVersion,
      upstreamPi,
    },
    paths: {
      agentDir: ctx.agentDir,
      repoRoot: ctx.repoRoot,
      skillsDir: ctx.skillsDir,
      packagesDir: ctx.packagesDir,
    },
    theme: currentTheme(ctx),
  };
  data.recommendations = buildVersionRecommendations(ctx, data, git, settings);
  if (json) {
    printJson(data);
    return;
  }
  keyValue("manager", `${data.manager.package}@${data.manager.version}`);
  keyValue("pi-67 distro", data.distro.version || "unknown");
  keyValue("git", `${data.distro.commit || "unknown"}${data.distro.dirty ? " dirty" : ""}`);
  keyValue("pi", data.runtime.pi || "not found");
  keyValue("pi tested", data.runtime.upstreamPi.testedVersion || "unknown");
  if (!data.runtime.upstreamPi.registry.skipped) {
    keyValue("pi latest", data.runtime.upstreamPi.registry.latestVersion || "unknown");
  }
  keyValue("node", data.runtime.node);
  keyValue("platform", data.runtime.platform);
  keyValue("agentDir", data.paths.agentDir);
  keyValue("theme", data.theme || "unset");
  printRecommendations(data.recommendations);
}

function buildVersionRecommendations(ctx, data, git, settings) {
  const recommendations = [];
  const managerVsDistro = compareSemver(data.manager.version, data.distro.version);
  const settingsDirty = git.short
    .split(/\r?\n/)
    .some((line) => line.trim().endsWith("settings.json"));
  const hasRuntimeMarker = settings && Object.prototype.hasOwnProperty.call(settings, "lastChangelogVersion");
  const updateCommand = `pi-67 --agent-dir "${ctx.agentDir}" --repo-root "${ctx.repoRoot}" update --repair`;

  if (managerVsDistro > 0) {
    recommendations.push({
      level: "WARN",
      message: `manager is ${data.manager.version} but local distro is ${data.distro.version || "unknown"}; npm install updated only the manager package.`,
    });
    recommendations.push({
      level: "INFO",
      message: `Run: ${updateCommand}`,
    });
  } else if (managerVsDistro < 0) {
    recommendations.push({
      level: "WARN",
      message: `local distro ${data.distro.version} is newer than manager ${data.manager.version}; update the manager with npm install -g ${data.manager.package}@latest.`,
    });
  }

  if (settingsDirty && hasRuntimeMarker) {
    recommendations.push({
      level: "INFO",
      message: "settings.json has Pi runtime changelog marker state; update --repair migrates it into ~/.pi/pi67/state.json and normalizes settings.json.",
    });
  } else if (settingsDirty) {
    recommendations.push({
      level: "INFO",
      message: "settings.json is dirty; inspect with git diff -- settings.json before updating if it contains personal provider/model/theme edits.",
    });
  }

  if (!data.runtime.pi) {
    recommendations.push({
      level: "INFO",
      message: "`pi` is not on PATH in this shell; this does not block pi-67 manager updates.",
    });
  } else if (data.runtime.upstreamPi.installedBehindTested) {
    recommendations.push({
      level: "WARN",
      message: `upstream Pi ${data.runtime.pi} is behind the release-tested ${data.runtime.upstreamPi.testedVersion}; run: ${data.runtime.upstreamPi.updateCommand}`,
    });
  } else if (data.runtime.upstreamPi.registry.outdated) {
    recommendations.push({
      level: "INFO",
      message: `upstream Pi ${data.runtime.pi} has registry latest ${data.runtime.upstreamPi.registry.latestVersion}; review upstream changes before updating.`,
    });
  }
  return recommendations;
}

function printRecommendations(recommendations) {
  if (!recommendations?.length) return;
  section("Next steps");
  for (const item of recommendations) {
    if (item.level === "WARN") warn(item.message);
    else info(item.message);
  }
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function parseSemver(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1, 4).map((item) => Number(item));
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
