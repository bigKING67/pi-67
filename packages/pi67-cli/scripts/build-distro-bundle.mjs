import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireSourcePackageLayout, resolveSourceRepoRoot } from "./source-package-layout.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = requireSourcePackageLayout(packageRoot, resolveSourceRepoRoot(packageRoot));
const targetRoot = path.join(packageRoot, "distro");

const ROOT_FILES = [
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "VERSION",
  "auth.example.json",
  "image-gen.example.json",
  "install.ps1",
  "install.sh",
  "mcp.example.json",
  "models.example.json",
  "package-lock.json",
  "package.json",
  "packages/pi67-cli/package.json",
  "settings.example.json",
  "shared-skill-packs.json",
  "shared-skill-packs.lock.json",
  "tsconfig.hy-memory.json",
  "tsconfig.json",
  "tsconfig.xtalpi.json",
];

const ROOT_DIRS = [
  "bin",
  "docs",
  "extensions",
  "prompts",
  // Runtime scripts keep source-relative imports to these package-owned libraries.
  "packages/pi67-cli/src/data",
  "packages/pi67-cli/src/lib",
  "rules",
  "scripts",
  "shared-skills",
  "templates",
  "tests",
  "themes",
];

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });

for (const rel of ROOT_FILES) {
  const source = path.join(repoRoot, rel);
  if (!fs.existsSync(source)) continue;
  copyPath(source, path.join(targetRoot, rel));
}
for (const rel of ROOT_DIRS) {
  const source = path.join(repoRoot, rel);
  if (!fs.existsSync(source)) continue;
  copyPath(source, path.join(targetRoot, rel));
}

const version = fs.readFileSync(path.join(targetRoot, "VERSION"), "utf8").trim();
const files = [];
walkFiles(targetRoot, targetRoot, files);
const manifest = {
  schema: "pi67.distro-bundle.v1",
  version,
  files: files.sort((left, right) => left.path.localeCompare(right.path)),
};
fs.writeFileSync(path.join(targetRoot, ".pi67-bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Built pi-67 distro bundle ${version}: ${files.length} files\n`);

function copyPath(source, target) {
  const stat = fs.lstatSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(source, target, {
      recursive: true,
      filter: (item) => !item.split(path.sep).some((part) => [".git", "node_modules", "__pycache__"].includes(part)),
    });
  } else {
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode & 0o777);
  }
}

function walkFiles(root, dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, files);
    else if (entry.isFile()) {
      files.push({
        path: path.relative(root, full).replace(/\\/g, "/"),
        size: fs.statSync(full).size,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
      });
    }
  }
}
