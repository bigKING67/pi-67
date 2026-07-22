import fs from "node:fs";
import path from "node:path";

export function resolveSourceRepoRoot(packageRoot) {
  return path.resolve(process.env.PI67_REPO_ROOT || path.join(packageRoot, "../.."));
}

export function isSourcePackageLayout(packageRoot, repoRoot = resolveSourceRepoRoot(packageRoot)) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  if (resolvedPackageRoot !== path.join(resolvedRepoRoot, "packages", "pi67-cli")) return false;

  return [
    path.join(resolvedRepoRoot, "VERSION"),
    path.join(resolvedRepoRoot, "package.json"),
    path.join(resolvedRepoRoot, "extensions"),
    path.join(resolvedRepoRoot, "shared-skills"),
    path.join(resolvedPackageRoot, "package.json"),
  ].every((marker) => fs.existsSync(marker));
}

export function requireSourcePackageLayout(packageRoot, repoRoot = resolveSourceRepoRoot(packageRoot)) {
  if (!isSourcePackageLayout(packageRoot, repoRoot)) {
    throw new Error(
      `pi-67 distro bundle generation requires the source checkout; refusing to mutate ${path.resolve(packageRoot)}`,
    );
  }
  return path.resolve(repoRoot);
}
