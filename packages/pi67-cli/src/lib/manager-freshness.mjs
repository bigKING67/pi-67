import path from "node:path";
import { compareSemver, npmLatestVersion } from "./npm-registry.mjs";
import { readCliPackageJson, readTextIfExists } from "./paths.mjs";
import { readCurrentRelease } from "./release-store.mjs";

export async function inspectManagerFreshness(ctx, options = {}) {
  const pkg = options.manager || readCliPackageJson();
  const packageName = pkg.name || pkg.package;
  if (!packageName || !pkg.version) {
    throw new Error("pi-67 manager identity requires a package name and version");
  }
  const distroVersion = Object.hasOwn(options, "currentDistroVersion")
    ? options.currentDistroVersion
    : (readCurrentRelease(ctx)?.version || readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim());
  const registry = await npmLatestVersion(packageName, {
    currentVersion: pkg.version,
    noRemote: ctx.noRemote || options.noRemote,
  });
  const managerBehindLocalDistro = Boolean(distroVersion) &&
    compareSemver(pkg.version, distroVersion) < 0;
  const registryOutdated = Boolean(registry.outdated);
  const blocking = managerBehindLocalDistro || registryOutdated;
  return {
    package: packageName,
    managerVersion: pkg.version,
    distroVersion,
    registry,
    managerBehindLocalDistro,
    registryOutdated,
    blocking,
    updateCommand: `npm install -g ${packageName}@latest`,
    selfUpdateCommand: "pi-67 self-update",
    oneShotCommand: `npx -y ${packageName}@latest update`,
  };
}

export function managerFreshnessStatus(freshness) {
  if (freshness.managerBehindLocalDistro) {
    return `manager ${freshness.managerVersion} is older than local distro ${freshness.distroVersion || "unknown"}`;
  }
  if (freshness.registryOutdated) {
    return `manager ${freshness.managerVersion} is older than npm latest ${freshness.registry.latestVersion || "unknown"}`;
  }
  if (freshness.registry?.skipped) return "registry check skipped";
  if (freshness.registry?.ok) return "current";
  return `registry unknown${freshness.registry?.message ? `: ${freshness.registry.message}` : ""}`;
}

export function managerFreshnessBlockReason(freshness) {
  return `${managerFreshnessStatus(freshness)}; update the npm manager first so pi-67 update/repair uses the latest safety gates`;
}
