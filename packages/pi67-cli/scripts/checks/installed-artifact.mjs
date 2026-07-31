import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSourcePackageLayout, resolveSourceRepoRoot } from "../source-package-layout.mjs";

export function runPackedArtifactSelfTests(packageRoot) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-packed-artifact-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmChildEnv = npmLifecycleChildEnv();
  const freshExtensionInstall = process.env.PI67_FRESH_EXTENSION_INSTALL === "1";
  const sourceCheckout = isSourcePackageLayout(packageRoot, resolveSourceRepoRoot(packageRoot));
  try {
    if (!sourceCheckout) {
      runInstalledArtifactChecks(packageRoot, tmpRoot, npmChildEnv, { freshExtensionInstall });
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

function runInstalledArtifactChecks(installedRoot, tmpRoot, npmChildEnv, options = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  const packageVersion = String(packageJson.version || "").trim();
  const distroVersionPath = path.join(installedRoot, "distro", "VERSION");
  const bundleManifestPath = path.join(installedRoot, "distro", ".pi67-bundle.json");
  assert(packageVersion, "packed artifact package.json must declare a version");
  assert(
    fs.existsSync(distroVersionPath) && fs.existsSync(bundleManifestPath),
    "packed artifact must include the matching immutable distro bundle",
  );
  const bundleManifest = JSON.parse(fs.readFileSync(bundleManifestPath, "utf8"));
  assert(
    fs.readFileSync(distroVersionPath, "utf8").trim() === packageVersion &&
      bundleManifest.version === packageVersion,
    "packed artifact manager, distro, and bundle manifest versions must match",
  );
  const hyMemoryRuntimeFiles = [
    "extensions/pi-hy-memory/python/requirements.in",
    "extensions/pi-hy-memory/python/lock-manifest.json",
    "extensions/pi-hy-memory/python/inspect_runtime.py",
    "extensions/pi-hy-memory/python/locks/cp311-macos-arm64.txt",
    "extensions/pi-hy-memory/python/locks/cp311-manylinux_2_28-x64.txt",
    "extensions/pi-hy-memory/python/locks/cp311-windows-x64.txt",
    "extensions/pi-hy-memory/python/vendor/langdetect-1.0.9-py3-none-any.whl",
    "extensions/pi-hy-memory/python/vendor/provenance.json",
    "packages/pi67-cli/src/lib/hy-memory-python-runtime.mjs",
    "scripts/pi67-hy-memory-python-lock.mjs",
  ];
  const bundleFiles = new Map(bundleManifest.files.map((item) => [item.path, item]));
  for (const relative of hyMemoryRuntimeFiles) {
    const file = path.join(installedRoot, "distro", ...relative.split("/"));
    const expected = bundleFiles.get(relative);
    assert(fs.existsSync(file) && expected, `packed artifact is missing Hy-Memory Python runtime contract: ${relative}`);
    const bytes = fs.readFileSync(file);
    assert(
      expected.size === bytes.length && expected.sha256 === crypto.createHash("sha256").update(bytes).digest("hex"),
      `packed artifact Hy-Memory Python runtime contract hash drifted: ${relative}`,
    );
  }
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

  if (options.freshExtensionInstall) {
    runFreshExtensionDependencyCheck(installedRoot, tmpRoot, npmChildEnv);
  }
}

function runFreshExtensionDependencyCheck(installedRoot, tmpRoot, npmChildEnv) {
  const managedExtensionsFile = path.join(installedRoot, "src", "lib", "managed-extensions.mjs");
  const baselinesFile = path.join(installedRoot, "src", "data", "managed-extension-baselines.json");
  const sourceRoot = path.join(installedRoot, "distro");
  const homeDir = path.join(tmpRoot, "fresh-extension-home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const stateDir = path.join(homeDir, ".pi", "pi67");
  const resultFile = path.join(tmpRoot, "fresh-extension-result.json");
  const probe = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'const [managedExtensionsFile, baselinesFile, sourceRoot, agentDir, stateDir, resultFile] = process.argv.slice(1);',
      'const { applyManagedExtensionBaselines } = await import(pathToFileURL(managedExtensionsFile).href);',
      'const baselines = JSON.parse(fs.readFileSync(baselinesFile, "utf8"));',
      'const smartFetch = baselines.extensions.find((entry) => entry.id === "pi-smart-fetch");',
      'if (!smartFetch) throw new Error("packed manager is missing the pi-smart-fetch baseline");',
      'const registry = { schema: baselines.schema, policy: baselines.policy, extensions: [smartFetch] };',
      'const applied = applyManagedExtensionBaselines(',
      '  { agentDir, repoRoot: sourceRoot, stateDir },',
      '  { registry, sourceRoot },',
      ');',
      'const npmRoot = path.join(agentDir, "npm");',
      'const distFile = path.join(npmRoot, "node_modules", "pi-smart-fetch", "dist", "index.js");',
      'const expectedIconvRoot = fs.realpathSync(path.join(npmRoot, "node_modules", "iconv-lite"));',
      'const iconvEntry = createRequire(distFile).resolve("iconv-lite");',
      'const iconvRelative = path.relative(expectedIconvRoot, fs.realpathSync(iconvEntry));',
      'if (iconvRelative.startsWith("..") || path.isAbsolute(iconvRelative)) {',
      '  throw new Error(`iconv-lite resolved outside the fresh extension npm tree: ${iconvEntry}`);',
      '}',
      'const runtimePackage = JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8"));',
      'const runtimeLock = JSON.parse(fs.readFileSync(path.join(npmRoot, "package-lock.json"), "utf8"));',
      'if (runtimePackage.dependencies?.["iconv-lite"] !== "0.7.3" || runtimeLock.packages?.["node_modules/iconv-lite"]?.version !== "0.7.3") {',
      '  throw new Error("fresh extension npm metadata does not pin iconv-lite@0.7.3");',
      '}',
      'const source = fs.readFileSync(distFile, "utf8");',
      'if (!source.includes("pi67-smart-fetch-charset-v1") || !source.includes("import iconv from \'iconv-lite\';")) {',
      '  throw new Error("fresh pi-smart-fetch package was not patched for declared response charsets");',
      '}',
      'const peerRoot = path.join(npmRoot, "node_modules", "@earendil-works", "pi-coding-agent");',
      'if (!fs.existsSync(peerRoot)) {',
      '  fs.mkdirSync(peerRoot, { recursive: true });',
      '  fs.writeFileSync(path.join(peerRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-fixture", type: "module", exports: "./index.js" }));',
      '  fs.writeFileSync(path.join(peerRoot, "index.js"), "export function getAgentDir(){return \'\';} export function getMarkdownTheme(){return {};} export function keyText(){return \'\';}\\n");',
      '}',
      'globalThis.require = createRequire(distFile);',
      'const extensionModule = await import(`${pathToFileURL(distFile).href}?fresh=${Date.now()}`);',
      'if (typeof extensionModule.default !== "function") throw new Error("fresh pi-smart-fetch extension did not load");',
      'const extension = applied.after.extensions[0];',
      'if (extension.status !== "at-baseline" || extension.runtimeDependencyClosure?.ready !== true) {',
      '  throw new Error(`fresh extension dependency closure is not healthy: ${JSON.stringify(extension)}`);',
      '}',
      'fs.writeFileSync(resultFile, JSON.stringify({',
      '  extensionVersion: extension.installedVersion,',
      '  iconvVersion: runtimeLock.packages["node_modules/iconv-lite"].version,',
      '  patched: true,',
      '  loaded: true,',
      '}));',
    ].join("\n"),
    managedExtensionsFile,
    baselinesFile,
    sourceRoot,
    agentDir,
    stateDir,
    resultFile,
  ], {
    cwd: tmpRoot,
    encoding: "utf8",
    env: { ...npmChildEnv, HOME: homeDir, USERPROFILE: homeDir },
    timeout: 300_000,
  });
  assert(
    probe.status === 0,
    `fresh packed extension install failed: ${probe.error?.message || probe.stderr || probe.stdout}`,
  );
  assert(fs.existsSync(resultFile), "fresh packed extension install did not produce its verification result");
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert(
    result.extensionVersion === "0.3.12" &&
      result.iconvVersion === "0.7.3" &&
      result.patched === true &&
      result.loaded === true,
    `fresh packed extension install returned an invalid result: ${JSON.stringify(result)}`,
  );
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
