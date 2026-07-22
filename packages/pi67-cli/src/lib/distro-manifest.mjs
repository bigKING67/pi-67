import fs from "node:fs";
import path from "node:path";
import { EXTERNAL_REPOS } from "./external-repos.mjs";
import { readJsonFileIfExists } from "./config-json.mjs";
import { packageRoot } from "./paths.mjs";
import { readExtensionRegistry } from "./extension-registry.mjs";
import { readManagedExtensionBaselines } from "./managed-extensions.mjs";

export function buildDistroManifest(ctx) {
  const base = readBaseManifest();
  const extensionRegistry = readExtensionRegistry();
  const managedExtensions = readManagedExtensionBaselines();
  const rootPackage = readJsonFileIfExists(path.join(ctx.repoRoot, "package.json")) || {};
  const rootLock = readJsonFileIfExists(path.join(ctx.repoRoot, "package-lock.json")) || {};
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const dependencies = rootPackage.dependencies || {};
  const dependencyPackages = Object.entries(dependencies)
    .map(([packageName, versionRange]) => ({
      spec: `npm:${packageName}`,
      packageName,
      versionRange,
      lockedVersion: lockedDependencyVersion(rootLock, packageName),
      owner: "pi67-managed",
      source: "package.json.dependencies+package-lock.json",
      role: packageName === base.theme.packageName ? "theme-package" : "pi-package",
      policy: packageName === base.theme.packageName
        ? base.theme.policy
        : "install-update-through-pi67-preserve-user-runtime-config",
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));

  const dependencyNames = new Set(dependencyPackages.map((item) => item.packageName));
  const knownRuntime = new Map((base.runtimePackageSpecs || []).map((item) => [item.spec, item]));
  const knownRuntimeNames = new Set((base.runtimePackageSpecs || []).map((item) => item.packageName));
  const settingsPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const runtimePackages = settingsPackages.map((spec) => {
    const packageName = packageNameFromSpec(spec);
    const known = knownRuntime.get(spec);
    const isThemePackage = packageName === base.theme.packageName;
    const managed = Boolean(known) || dependencyNames.has(packageName) || knownRuntimeNames.has(packageName);
    return {
      spec,
      packageName,
      owner: managed ? "pi67-managed" : "user-managed",
      source: "settings.json.packages",
      role: isThemePackage ? "theme-package" : "runtime-package",
      dependencyManaged: dependencyNames.has(packageName),
      policy: isThemePackage ? base.theme.policy : known?.policy || (managed
        ? "preserve-user-config-and-repair-known-drift"
        : "report-only-do-not-overwrite"),
    };
  });

  const managedExtensionNames = new Set((base.localExtensions || []).map((item) => item.name));
  const localExtensions = (base.localExtensions || []).map((item) => ({
    ...item,
    owner: "pi67-managed",
    exists: fs.existsSync(path.join(ctx.agentDir, item.path)),
  })).concat(scanUserLocalExtensions(ctx, managedExtensionNames));
  const userManagedPackages = runtimePackages.filter((item) => item.owner === "user-managed");

  return {
    schema: "pi67.distro-manifest.v1",
    createdAt: new Date().toISOString(),
    ownership: base.ownership,
    commands: base.commands,
    releaseStore: base.releaseStore,
    managedExtensions: {
      ...base.managedExtensions,
      schema: managedExtensions.schema,
      policyModel: managedExtensions.policy,
      extensions: managedExtensions.extensions,
    },
    runtimeFiles: base.runtimeFiles,
    theme: base.theme,
    sharedSkills: {
      ...base.sharedSkills,
      activeDir: ctx.skillsDir,
    },
    externalReposPolicy: base.externalReposPolicy,
    extensionRegistry,
    localExtensions,
    dependencyPackages,
    runtimePackages,
    externalRepos: Object.values(EXTERNAL_REPOS),
    summary: {
      dependencies: dependencyPackages.length,
      runtimePackages: runtimePackages.length,
      pi67ManagedRuntimePackages: runtimePackages.length - userManagedPackages.length,
      userManagedRuntimePackages: userManagedPackages.length,
      localExtensions: localExtensions.length,
      missingLocalExtensions: localExtensions.filter((item) => !item.exists).length,
      externalRepos: Object.keys(EXTERNAL_REPOS).length,
      runtimeFilesPreserved: base.runtimeFiles.preserve.length,
      registeredExtensions: extensionRegistry.extensions.length,
      managedExtensions: managedExtensions.extensions.length,
    },
    userManagedPackages,
  };
}

export function lockedDependencyVersion(lockfile, packageName) {
  const direct = lockfile?.packages?.[`node_modules/${packageName}`]?.version;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const legacy = lockfile?.dependencies?.[packageName]?.version;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  return "";
}

export function packageNameFromSpec(spec) {
  const value = String(spec || "");
  if (value.startsWith("npm:")) return npmPackageName(value.slice(4));
  if (value.startsWith("git:")) {
    const repo = value.split("/").pop() || value;
    return repo.replace(/\.git$/, "");
  }
  if (value.startsWith("local:")) return path.basename(value);
  return value;
}

function npmPackageName(value) {
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    if (slash === -1) return value;
    const versionAt = value.indexOf("@", slash + 1);
    return versionAt === -1 ? value : value.slice(0, versionAt);
  }
  const versionAt = value.indexOf("@");
  return versionAt === -1 ? value : value.slice(0, versionAt);
}

function scanUserLocalExtensions(ctx, managedNames) {
  const extensionsRoot = path.join(ctx.agentDir, "extensions");
  if (!fs.existsSync(extensionsRoot)) return [];
  return fs.readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !managedNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join("extensions", entry.name),
      required: false,
      owner: "user-managed",
      policy: "report-only-do-not-overwrite",
      exists: true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readBaseManifest() {
  const file = path.join(packageRoot(), "src", "data", "distro-manifest.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
