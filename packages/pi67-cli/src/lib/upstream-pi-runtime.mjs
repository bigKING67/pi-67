import { buildDistroManifest } from "./distro-manifest.mjs";
import { npmLatestVersion, compareSemver, versionFromRange } from "./npm-registry.mjs";
import { captureCommand } from "./shell-runner.mjs";

export async function inspectUpstreamPiRuntime(ctx, options = {}) {
  const manifest = options.manifest || buildDistroManifest(ctx);
  const policy = manifest.upstreamPi || {};
  const command = policy.command || "pi";
  const packageName = policy.packageName || "@earendil-works/pi-coding-agent";
  const testedVersion = versionFromRange(policy.testedVersion);
  const commandResult = (options.captureCommand || captureCommand)(command, ["--version"]);
  const versionText = commandResult.ok
    ? String(commandResult.stdout || commandResult.stderr || "").trim()
    : "";
  const installedVersion = versionFromRange(versionText);
  const installedBehindTested = Boolean(installedVersion && testedVersion) &&
    compareSemver(installedVersion, testedVersion) < 0;
  const installedAheadOfTested = Boolean(installedVersion && testedVersion) &&
    compareSemver(installedVersion, testedVersion) > 0;
  const registry = await npmLatestVersion(packageName, {
    currentVersion: installedVersion,
    noRemote: Boolean(options.noRemote),
    ...(options.registryOptions || {}),
  });

  return {
    package: packageName,
    command,
    installed: Boolean(commandResult.ok),
    commandOk: Boolean(commandResult.ok),
    installedVersion,
    testedVersion,
    installedBehindTested,
    installedAheadOfTested,
    compatibility: compatibilityStatus({
      commandOk: commandResult.ok,
      installedVersion,
      testedVersion,
      installedBehindTested,
      installedAheadOfTested,
    }),
    policy: policy.compatibilityPolicy || "",
    updateCommand: policy.updateCommand || `npm install -g ${packageName}@latest`,
    registry,
  };
}

export function upstreamPiCheck(runtime) {
  if (!runtime?.commandOk) {
    return {
      level: "FAIL",
      message: "pi command not found or `pi --version` failed",
    };
  }
  if (!runtime.installedVersion) {
    return {
      level: "WARN",
      message: "pi exists but its version could not be parsed",
    };
  }
  if (runtime.installedBehindTested) {
    return {
      level: "WARN",
      message: `pi found: ${runtime.installedVersion}; behind release-tested ${runtime.testedVersion}; run: ${runtime.updateCommand}`,
    };
  }
  if (runtime.testedVersion) {
    return {
      level: "PASS",
      message: `pi found: ${runtime.installedVersion}; release-tested baseline ${runtime.testedVersion} satisfied`,
    };
  }
  return {
    level: "PASS",
    message: `pi found: ${runtime.installedVersion}`,
  };
}

function compatibilityStatus({
  commandOk,
  installedVersion,
  testedVersion,
  installedBehindTested,
  installedAheadOfTested,
}) {
  if (!commandOk) return "missing-or-failed";
  if (!installedVersion) return "unknown-version";
  if (!testedVersion) return "installed-unbounded";
  if (installedBehindTested) return "behind-release-tested";
  if (installedAheadOfTested) return "newer-than-release-tested";
  return "release-tested";
}
