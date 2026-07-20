import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function runPackedArtifactSelfTests(packageRoot) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-packed-artifact-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmChildEnv = npmLifecycleChildEnv();
  try {
    const pack = spawnSync(npm, ["pack", packageRoot, "--ignore-scripts", "--json", "--pack-destination", tmpRoot], {
      cwd: tmpRoot,
      encoding: "utf8",
      env: npmChildEnv,
      shell: process.platform === "win32",
    });
    assert(pack.status === 0, `packed artifact creation failed: ${pack.error?.message || pack.stderr || pack.stdout}`);
    const packed = JSON.parse(pack.stdout);
    const tarball = path.join(tmpRoot, packed[0]?.filename || "");
    assert(fs.existsSync(tarball), "packed artifact tarball was not created");

    fs.writeFileSync(path.join(tmpRoot, "package.json"), '{"private":true}\n', "utf8");
    const install = spawnSync(npm, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      tarball,
    ], {
      cwd: tmpRoot,
      encoding: "utf8",
      env: npmChildEnv,
      shell: process.platform === "win32",
    });
    assert(install.status === 0, `packed artifact install failed: ${install.error?.message || install.stderr || install.stdout}`);

    const bin = path.join(tmpRoot, "node_modules", "@bigking67", "pi-67", "bin", "pi-67.mjs");
    const help = spawnSync(process.execPath, [bin, "external", "--help"], {
      cwd: tmpRoot,
      encoding: "utf8",
    });
    assert(help.status === 0, `packed artifact CLI failed to start: ${help.stderr || help.stdout}`);
    assert(
      help.stdout.includes("external install <browser67|design-craft>") &&
        help.stdout.includes("browser67 install performs the complete first-time") &&
        help.stdout.includes("external doctor <browser67|design-craft> [--deep]"),
      "packed artifact external help is missing the complete install/update/setup lifecycle",
    );

    const memoryHelp = spawnSync(process.execPath, [bin, "memory", "--help"], {
      cwd: tmpRoot,
      encoding: "utf8",
    });
    assert(memoryHelp.status === 0, `packed artifact memory CLI failed to start: ${memoryHelp.stderr || memoryHelp.stdout}`);
    assert(
      memoryHelp.stdout.includes("pi-67 memory init") &&
        memoryHelp.stdout.includes("BAAI/bge-m3") &&
        memoryHelp.stdout.includes("Secrets are stored outside the repository"),
      `packed artifact memory help is missing the initialization and private-state contract: ${JSON.stringify(memoryHelp.stdout)}`,
    );

    const installedRoot = path.join(tmpRoot, "node_modules", "@bigking67", "pi-67");
    for (const checkModule of ["installed-artifact.mjs", "settings-runtime-state.mjs"]) {
      const modulePath = path.join(installedRoot, "scripts", "checks", checkModule);
      const imported = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]).href);',
        modulePath,
      ], {
        cwd: tmpRoot,
        encoding: "utf8",
      });
      assert(
        imported.status === 0,
        `packed artifact check module failed to import: ${checkModule}\n${imported.stderr || imported.stdout}`,
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function npmLifecycleChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "npm_config_dry_run") delete env[key];
  }
  env.npm_config_dry_run = "false";
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
