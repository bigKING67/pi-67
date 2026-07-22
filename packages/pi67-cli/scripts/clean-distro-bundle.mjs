import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSourcePackageLayout, resolveSourceRepoRoot } from "./source-package-layout.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolveSourceRepoRoot(packageRoot);
if (isSourcePackageLayout(packageRoot, repoRoot)) {
  fs.rmSync(path.join(packageRoot, "distro"), { recursive: true, force: true });
}
