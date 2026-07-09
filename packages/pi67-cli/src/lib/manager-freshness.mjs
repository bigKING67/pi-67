import path from "node:path";
import { compareSemver, npmLatestVersion } from "./npm-registry.mjs";
import { readCliPackageJson, readTextIfExists } from "./paths.mjs";

export async function inspectManagerFreshness(ctx, options = {}) {
  const pkg = readCliPackageJson();
  const distroVersion = readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim();
  const registry = await npmLatestVersion(pkg.name, {
    currentVersion: pkg.version,
    noRemote: ctx.noRemote || options.noRemote,
  });
  const managerBehindLocalDistro = Boolean(distroVersion) &&
    compareSemver(pkg.version, distroVersion) < 0;
  const registryOutdated = Boolean(registry.outdated);
  const blocking = managerBehindLocalDistro || registryOutdated;
  return {
    package: pkg.name,
    managerVersion: pkg.version,
    distroVersion,
    registry,
    managerBehindLocalDistro,
    registryOutdated,
    blocking,
    updateCommand: `npm install -g ${pkg.name}@latest`,
    selfUpdateCommand: "pi-67 self-update",
    oneShotCommand: `npx -y ${pkg.name}@latest update --repair`,
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
