import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSourcePackageLayout, resolveSourceRepoRoot } from "../source-package-layout.mjs";

export function runPackedArtifactSelfTests(packageRoot) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-packed-artifact-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmChildEnv = npmLifecycleChildEnv();
  const sourceCheckout = isSourcePackageLayout(packageRoot, resolveSourceRepoRoot(packageRoot));
  try {
    if (!sourceCheckout) {
      runInstalledArtifactChecks(packageRoot, tmpRoot, npmChildEnv);
      return;
    }

    const buildBundle = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "build-distro-bundle.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      env: npmChildEnv,
    });
    assert(buildBundle.status === 0, `distro bundle build failed: ${buildBundle.stderr || buildBundle.stdout}`);
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

    const installedRoot = path.join(tmpRoot, "node_modules", "@bigking67", "pi-67");
    const installedCheck = spawnSync(process.execPath, [path.join(installedRoot, "scripts", "check.mjs")], {
      cwd: tmpRoot,
      encoding: "utf8",
      env: npmChildEnv,
    });
    assert(
      installedCheck.status === 0,
      `installed package self-test failed: ${installedCheck.error?.message || installedCheck.stderr || installedCheck.stdout}`,
    );
    assert(
      fs.existsSync(path.join(installedRoot, "distro", "VERSION")),
      "installed package self-test must preserve its immutable distro bundle",
    );
  } finally {
    if (sourceCheckout) {
      spawnSync(process.execPath, [path.join(packageRoot, "scripts", "clean-distro-bundle.mjs")], {
        cwd: packageRoot,
        encoding: "utf8",
      });
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runInstalledArtifactChecks(installedRoot, tmpRoot, npmChildEnv) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  const packageVersion = String(packageJson.version || "").trim();
  const distroVersionPath = path.join(installedRoot, "distro", "VERSION");
  const bundleManifestPath = path.join(installedRoot, "distro", ".pi67-bundle.json");
  assert(packageVersion, "packed artifact package.json must declare a version");
  assert(
    fs.existsSync(distroVersionPath) && fs.existsSync(bundleManifestPath),
    "packed artifact must include the matching immutable distro bundle",
  );
  assert(
    fs.readFileSync(distroVersionPath, "utf8").trim() === packageVersion &&
      JSON.parse(fs.readFileSync(bundleManifestPath, "utf8")).version === packageVersion,
    "packed artifact manager, distro, and bundle manifest versions must match",
  );
  assert(
    fs.existsSync(path.join(installedRoot, "distro", "packages", "pi67-cli", "package.json")) &&
      fs.existsSync(path.join(installedRoot, "distro", "packages", "pi67-cli", "src", "data", "distro-manifest.json")) &&
      fs.existsSync(path.join(installedRoot, "distro", "packages", "pi67-cli", "src", "lib", "xtalpi-config.mjs")),
    "packed artifact distro must include libraries imported by runtime scripts",
  );

  const bin = path.join(installedRoot, "bin", "pi-67.mjs");
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

  for (const runtimeScript of [
    "pi67-shared-skill-packs-status.mjs",
    "pi67-sync-commerce-skill-pack.mjs",
    "pi67-sync-ai-berkshire-skill-pack.mjs",
  ]) {
    const scriptHelp = spawnSync(process.execPath, [
      path.join(installedRoot, "distro", "scripts", runtimeScript),
      "--help",
    ], {
      cwd: tmpRoot,
      encoding: "utf8",
    });
    assert(
      scriptHelp.status === 0,
      `packed runtime script failed to load: ${runtimeScript}\n${scriptHelp.stderr || scriptHelp.stdout}`,
    );
  }

  const installHome = path.join(tmpRoot, "install-home");
  const installAgent = path.join(installHome, ".pi", "agent");
  const installSkills = path.join(installHome, ".agents", "skills");
  const installPreview = spawnSync(process.execPath, [
    bin,
    "--agent-dir", installAgent,
    "--repo-root", installAgent,
    "--skills-dir", installSkills,
    "install", "--dry-run", "--no-npm", "--json",
  ], {
    cwd: tmpRoot,
    encoding: "utf8",
    env: { ...npmChildEnv, HOME: installHome, USERPROFILE: installHome },
  });
  assert(installPreview.status === 0, `packed artifact install preview failed: ${installPreview.stderr || installPreview.stdout}`);
  const installPlan = JSON.parse(installPreview.stdout);
  assert(
    installPlan.activation?.version === packageVersion && !String(installPreview.stdout).includes("git clone"),
    "packed artifact install must use its own matching distro without Git clone",
  );

  const releaseStorePath = path.join(installedRoot, "src", "lib", "release-store.mjs");
  const stateDir = path.join(installHome, ".pi", "pi67");
  const stageProbe = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'const { stageDistroRelease } = await import(pathToFileURL(process.argv[1]).href);',
      'const ctx = { agentDir: process.argv[3], repoRoot: process.argv[3], stateDir: process.argv[4] };',
      'const result = stageDistroRelease(ctx, { sourceRoot: process.argv[2] });',
      'if (!fs.existsSync(path.join(result.releasePath, ".pi67-bundle.json"))) process.exit(3);',
      'process.stdout.write(JSON.stringify(result));',
    ].join("\n"),
    releaseStorePath,
    path.join(installedRoot, "distro"),
    installAgent,
    stateDir,
  ], {
    cwd: tmpRoot,
    encoding: "utf8",
    env: { ...npmChildEnv, HOME: installHome, USERPROFILE: installHome },
  });
  assert(
    stageProbe.status === 0,
    `packed artifact immutable staging failed: ${stageProbe.stderr || stageProbe.stdout}`,
  );
  const staged = JSON.parse(stageProbe.stdout);
  assert(
    staged.version === packageVersion && staged.created === true,
    "packed artifact must stage a verified immutable release",
  );

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
