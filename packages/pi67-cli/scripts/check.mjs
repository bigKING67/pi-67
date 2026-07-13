import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  npmLatestVersion,
  npmPublishTargetStatus,
  npmRegistryPackageUrl,
  versionFromRange,
  versionSatisfiesSupportedRange,
} from "../src/lib/npm-registry.mjs";
import {
  commandCandidatesForPlatform,
  envWithWindowsGitFallback,
  findWindowsGitExecutable,
  persistWindowsUserPathDirectory,
  repairWindowsGitPath,
  spawnCommandWithFallback,
} from "../src/lib/shell-runner.mjs";
import { parseCommandOptions, splitGlobalArgs } from "../src/lib/args.mjs";
import { readExtensionRegistry, validateExtensionRegistry } from "../src/lib/extension-registry.mjs";
import { buildPlanDecisions, classifyGitShort } from "../src/lib/update-plan.mjs";
import {
  migrateSettingsRuntimeState,
  mergeSettingsRuntimeMarkerIntoState,
  refreshSettingsGitIndex,
  settingsRuntimeMarkerFromObject,
  stripSettingsRuntimeMarkerText,
} from "../src/lib/settings-runtime-state.mjs";
import {
  beginUpdateLifecycle,
  inspectLegacyConflictBackup,
  inspectRuntimeBackup,
  listLegacyConflictBackups,
  listRuntimeBackups,
  restoreRuntimeBackup,
} from "../src/lib/update-safety.mjs";
import {
  managerFreshnessBlockReason,
  managerFreshnessStatus,
} from "../src/lib/manager-freshness.mjs";
import {
  inspectUpstreamPiRuntime,
  upstreamPiCheck,
} from "../src/lib/upstream-pi-runtime.mjs";
import {
  configureBrowser67Mcp,
  inspectBrowser67Runtime,
  setupBrowser67,
} from "../src/lib/browser67-runtime.mjs";
import {
  configureXtalpiModels,
  decodeJsonDocument,
  replaceFileSafely,
} from "../src/lib/xtalpi-config.mjs";
import {
  inspectSkillPackStatus,
  inventorySkillPacks,
  syncSkillPack,
} from "../src/lib/skill-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
walk(path.join(root, "bin"), files);
walk(path.join(root, "src"), files);
walk(path.join(root, "schemas"), files);
for (const file of files.filter((item) => item.endsWith(".mjs"))) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const file of files.filter((item) => item.endsWith(".json"))) {
  JSON.parse(fs.readFileSync(file, "utf8"));
}
await runNpmRegistrySelfTests();
await runUpstreamPiRuntimeSelfTests();
runBrowser67RuntimeSelfTests();
runPackedArtifactSelfTests();
runArgsSelfTests();
runCliHelpContractSelfTests();
runXtalpiConfigureSelfTests();
runProviderStatusSelfTests();
runInstallNonGitAgentDirSelfTests();
runVersionRecommendationSelfTests();
runPublishTargetSelfTests();
runShellRunnerSelfTests();
runExtensionRegistrySelfTests();
runSettingsRuntimeStateSelfTests();
runUpdatePreflightMigrationSelfTests();
runUpdatePlanSelfTests();
runUpdateSafetySelfTests();
runSkillPackPolicySelfTests();

function walk(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
}

function runArgsSelfTests() {
  const afterCommandHelp = splitGlobalArgs(["skills", "--help"]);
  assert(
    !afterCommandHelp.globals.help && afterCommandHelp.rest.join(" ") === "skills --help",
    "command-level --help must not be consumed as global help after a command is seen",
  );
  const globalHelp = splitGlobalArgs(["--help"]);
  assert(globalHelp.globals.help && globalHelp.rest.length === 0, "global --help must still be parsed globally");
  assert(
    parseCommandOptions(["--help"], { bools: [] }).options.help,
    "command option parser must accept --help for every command",
  );
  assert(
    parseCommandOptions(["--no-pi-list"], { bools: ["no-pi-list"] }).options.noPiList,
    "command option parser must accept doctor --no-pi-list",
  );
  assert(
    parseCommandOptions(["--no-skill-list"], { bools: ["no-skill-list"] }).options.noSkillList,
    "command option parser must retain the doctor --no-skill-list compatibility alias",
  );
  assert(
    parseCommandOptions(["--json"], { bools: ["json"] }).options.json,
    "command option parser must accept command-level --json",
  );
}

function runSkillPackPolicySelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-skill-pack-policy-"));
  const repoRoot = path.join(tmpRoot, "repo");
  const skillsDir = path.join(tmpRoot, "skills");
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(path.join(repoRoot, "shared-skills", "pack-a"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "shared-skills", "pack-b"), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "pack-a"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "shared-skills", "pack-a", "SKILL.md"), "source-a\n");
  fs.writeFileSync(path.join(repoRoot, "shared-skills", "pack-b", "SKILL.md"), "source-b\n");
  fs.writeFileSync(path.join(skillsDir, "pack-a", "SKILL.md"), "old-a\n");
  fs.writeFileSync(path.join(repoRoot, "shared-skill-packs.json"), `${JSON.stringify({
    schema: "pi67.shared-skill-packs.v1",
    packs: [{
      name: "fixture-pack",
      version: "1.0.0",
      upstream: "https://example.invalid/fixture-pack",
      skills: ["pack-a", "pack-b"],
    }],
  }, null, 2)}\n`);
  const ctx = { repoRoot, skillsDir, stateDir };

  const dryOnlySkillsDir = path.join(tmpRoot, "dry-only-skills");
  syncSkillPack({ ...ctx, skillsDir: dryOnlySkillsDir }, "fixture-pack", { dryRun: true, yes: true });
  assert(!fs.existsSync(dryOnlySkillsDir), "skill pack dry-run must not create the target root");

  const before = inventorySkillPacks(ctx).packs[0];
  assert(before.summary.conflicts === 1 && before.summary.missing === 1, "skill pack inventory must expose conflicts and missing skills");
  const beforeStatus = inspectSkillPackStatus(ctx);
  assert(beforeStatus.schemaId === "pi67-shared-skill-packs-status/v1", "skill pack status schema must be stable");
  assert(beforeStatus.registry.valid, "skill pack status must validate a well-formed registry");
  assert(beforeStatus.summary.attention === 1, "skill pack status must summarize inconsistent packs");
  assert(
    beforeStatus.packs[0].missingSkills.includes("pack-b") && beforeStatus.packs[0].conflictSkills.includes("pack-a"),
    "skill pack status must expose missing and conflicting skill names",
  );
  assert(
    beforeStatus.packs[0].commands.preview === "pi-67 skills sync-pack fixture-pack --dry-run",
    "skill pack status must provide a non-writing preview command",
  );
  const dryRun = syncSkillPack(ctx, "fixture-pack", { dryRun: true, yes: true });
  assert(dryRun.actions.some((item) => item.action === "replace-dry-run"), "skill pack dry-run must plan explicit replacement");
  assert(dryRun.actions.some((item) => item.action === "copy-dry-run"), "skill pack dry-run must plan missing skill copy");
  assert(fs.readFileSync(path.join(skillsDir, "pack-a", "SKILL.md"), "utf8") === "old-a\n", "skill pack dry-run must not write");

  syncSkillPack(ctx, "fixture-pack", { yes: true });
  const after = inventorySkillPacks(ctx).packs[0];
  assert(after.consistent, "explicit skill pack sync must make every pack skill consistent");
  const afterStatus = inspectSkillPackStatus(ctx);
  assert(afterStatus.summary.consistent === 1 && afterStatus.summary.attention === 0, "skill pack status must turn green after sync");
  assert(fs.readFileSync(path.join(skillsDir, "pack-b", "SKILL.md"), "utf8") === "source-b\n", "skill pack sync must copy missing skills");
  const backupsRoot = path.join(stateDir, "backups");
  assert(fs.existsSync(backupsRoot) && fs.readdirSync(backupsRoot).length > 0, "skill pack replacement must create a backup");
  assert(!fs.readdirSync(skillsDir).some((name) => name.startsWith(".pi67-skills-sync-")), "skill pack sync must clean transaction paths");

  const registryPath = path.join(repoRoot, "shared-skill-packs.json");
  const validRegistry = fs.readFileSync(registryPath, "utf8");
  fs.writeFileSync(registryPath, validRegistry.replace('"1.0.0"', '"not-semver"'));
  const invalidVersion = inspectSkillPackStatus(ctx);
  assert(!invalidVersion.registry.valid && invalidVersion.errors[0].includes("SemVer"), "skill pack status must reject invalid versions");
  fs.writeFileSync(registryPath, `${JSON.stringify({
    schema: "pi67.shared-skill-packs.v1",
    packs: [
      { name: "fixture-pack", version: "1.0.0", skills: ["pack-a"] },
      { name: "fixture-pack-two", version: "1.0.0", skills: ["pack-a"] },
    ],
  }, null, 2)}\n`);
  const duplicateOwner = inspectSkillPackStatus(ctx);
  assert(
    !duplicateOwner.registry.valid && duplicateOwner.errors[0].includes("assigned to multiple packs"),
    "skill pack status must reject ambiguous cross-pack skill ownership",
  );
  fs.writeFileSync(registryPath, validRegistry);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runBrowser67RuntimeSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-browser67-runtime-"));
  const home = path.join(tmpRoot, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const skillsDir = path.join(home, ".agents", "skills");
  const packagesDir = path.join(home, ".agents", "packages");
  const stateDir = path.join(home, ".pi", "pi67");
  const browserRoot = path.join(packagesDir, "browser67");
  fs.mkdirSync(path.join(browserRoot, "src", "mcp", "browser"), { recursive: true });
  fs.mkdirSync(path.join(browserRoot, "src", "mcp", "js-reverse"), { recursive: true });
  fs.mkdirSync(path.join(browserRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(home, ".browser67", "browser", "tmwd_cdp_bridge"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(browserRoot, "package.json"), '{"name":"browser67"}\n', "utf8");
  fs.writeFileSync(path.join(browserRoot, "src", "mcp", "browser", "server.mjs"), "\n", "utf8");
  fs.writeFileSync(path.join(browserRoot, "src", "mcp", "js-reverse", "server.mjs"), "\n", "utf8");
  fs.writeFileSync(path.join(home, ".browser67", "browser", "tmwd_cdp_bridge", "manifest.json"), "{}\n", "utf8");
  for (const skill of ["browser67", "js-reverse"]) {
    fs.mkdirSync(path.join(skillsDir, skill), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, skill, "SKILL.md"), `# ${skill}\n`, "utf8");
  }

  const ctx = { agentDir, skillsDir, packagesDir, stateDir };
  const commands = [];
  const setup = setupBrowser67(ctx, {
    root: browserRoot,
    startHub: true,
    runCommand(command, args, options) {
      commands.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert(
    commands.map((item) => item.args.join(" ")).join("|") ===
      "ci|run setup|run skills:active:sync -- --target " + skillsDir + "|run hub:start",
    "browser67 setup must install dependencies, prepare extension, sync active skills, and optionally start the hub",
  );
  assert(setup.steps.some((step) => step.id === "mcp-config" && step.changed), "browser67 setup must configure Pi MCP");

  const status = inspectBrowser67Runtime(ctx, {
    root: browserRoot,
    home,
  });
  assert(status.deterministicReady, "browser67 deterministic readiness fixture must pass");
  const deep = inspectBrowser67Runtime(ctx, {
    root: browserRoot,
    home,
    deep: true,
    captureCommand() {
      return { ok: true, status: 0, stdout: '{"ok":true}\n', stderr: "", error: "" };
    },
  });
  assert(deep.ready && deep.live.ok, "browser67 deep doctor must include a passing live probe");

  const mcpFile = path.join(agentDir, "mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
  mcp.mcpServers.tmwd_browser.cwd = path.join(tmpRoot, "wrong-browser67");
  fs.writeFileSync(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
  const repaired = configureBrowser67Mcp(ctx, browserRoot);
  assert(repaired.changed && repaired.backup && fs.existsSync(repaired.backup), "browser67 MCP repair must create a backup");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runPackedArtifactSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-packed-artifact-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const pack = spawnSync(npm, ["pack", root, "--ignore-scripts", "--json", "--pack-destination", tmpRoot], {
      cwd: tmpRoot,
      encoding: "utf8",
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
      help.stdout.includes("external setup browser67") && help.stdout.includes("external doctor <browser67|design-craft> [--deep]"),
      "packed artifact external help is missing browser67 setup/deep doctor",
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runCliHelpContractSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-help-contract-"));
  const home = path.join(tmpRoot, "home");
  const agentDir = path.join(tmpRoot, "agent");
  const skillsDir = path.join(tmpRoot, "skills");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const globalArgs = ["--agent-dir", agentDir, "--repo-root", root, "--skills-dir", skillsDir];
  const commands = [
    ["--help"],
    ["install", "--help"],
    ["update", "--help"],
    ["doctor", "--help"],
    ["smoke", "--help"],
    ["status", "--help"],
    ["report", "--help"],
    ["version", "--help"],
    ["xtalpi", "--help"],
    ["themes", "--help"],
    ["skills", "--help"],
    ["extensions", "--help"],
    ["external", "--help"],
    ["self-update", "--help"],
    ["publish-check", "--help"],
    ["manifest", "--help"],
    ["backups", "--help"],
    ["launch", "--help"],
  ];
  const backupRoot = path.join(home, ".pi", "pi67", "backups");
  for (const command of commands) {
    const result = spawnSync(process.execPath, [path.join(root, "bin", "pi-67.mjs"), ...globalArgs, ...command], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert(result.status === 0, `help command failed: pi-67 ${command.join(" ")}\n${result.stderr || result.stdout}`);
    assert(!result.stderr.trim(), `help command wrote stderr: pi-67 ${command.join(" ")}\n${result.stderr}`);
    assert(result.stdout.includes("Usage:"), `help command must print Usage: pi-67 ${command.join(" ")}`);
    if (command[0] === "--help") {
      assert(
        result.stdout.includes("launch               Optional Windows PATH compatibility wrapper for pi"),
        "global help must keep pi-67 launch in its optional compatibility role",
      );
    }
    if (command[0] === "launch") {
      assert(
        result.stdout.includes("Daily use should run `pi` directly."),
        "launch help must preserve the upstream Pi daily-entrypoint boundary",
      );
    }
    if (command[0] === "xtalpi") {
      assert(
        result.stdout.includes("pi-67 xtalpi configure") &&
          result.stdout.includes("never accepts a plaintext"),
        "xtalpi help must document the safe configure command",
      );
    }
    if (command[0] === "external") {
      assert(
        result.stdout.includes("external setup browser67") &&
          result.stdout.includes("external doctor browser67 --deep"),
        "external help must document complete browser67 setup and layered readiness",
      );
    }
  }
  const capabilityOutput = path.join(tmpRoot, "capability.json");
  const capability = spawnSync(
    process.execPath,
    [
      path.join(root, "bin", "pi-67.mjs"),
      ...globalArgs,
      "xtalpi",
      "capability",
      "--dry-run",
      "--provider",
      "test-provider",
      "--model",
      "test-model",
      "--timeout-ms",
      "30000",
      "--json-action-runs",
      "5",
      "--skip-native-probes",
      "--output-file",
      capabilityOutput,
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  assert(capability.status === 0, `xtalpi capability dry-run failed\n${capability.stderr || capability.stdout}`);
  for (const expectedArg of [
    "--provider test-provider",
    "--model test-model",
    "--timeout-ms 30000",
    "--json-action-runs 5",
    "--skip-native-probes",
    `--output-file ${capabilityOutput}`,
  ]) {
    assert(capability.stdout.includes(expectedArg), `xtalpi capability must forward ${expectedArg}\n${capability.stdout}`);
  }
  assert(
    !fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0,
    "help commands must not create runtime backups",
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runXtalpiConfigureSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-xtalpi-config-"));
  const repoRoot = path.join(tmpRoot, "repo");
  const agentDir = path.join(tmpRoot, "agent");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const example = {
    providers: {
      "xtalpi-pi-tools": {
        baseUrl: "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1",
        api: "xtalpi-pi-tools",
        apiKey: "YOUR_XTALPI_API_KEY",
        models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
      },
      codex: {
        baseUrl: "http://127.0.0.1:8317/v1",
        api: "openai-responses",
        apiKey: "YOUR_CODEX_API_KEY",
        models: [{ id: "gpt-test" }],
      },
    },
  };
  fs.writeFileSync(path.join(repoRoot, "models.example.json"), `${JSON.stringify(example, null, 2)}\n`);

  try {
    const existing = JSON.parse(JSON.stringify(example));
    existing.providers.codex.localOnly = true;
    const utf16 = Buffer.from(`${JSON.stringify(existing, null, 2)}\n`, "utf16le");
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]),
    );
    const key = "xtalpi-self-test-secret-123456";
    const configured = configureXtalpiModels({
      agentDir,
      repoRoot,
      apiKey: key,
      now: new Date("2026-07-12T00:00:00Z"),
    });
    assert(configured.changed, "xtalpi configure must report a changed UTF-16 config");
    assert(configured.normalized, "xtalpi configure must normalize Windows JSON encodings");
    assert(fs.existsSync(configured.backupPath), "xtalpi configure must preserve an encoding backup");
    const writtenBytes = fs.readFileSync(path.join(agentDir, "models.json"));
    assert(
      !(writtenBytes[0] === 0xff && writtenBytes[1] === 0xfe) &&
        !(writtenBytes[0] === 0xef && writtenBytes[1] === 0xbb && writtenBytes[2] === 0xbf),
      "xtalpi configure must write UTF-8 without BOM",
    );
    const written = JSON.parse(writtenBytes.toString("utf8"));
    assert(written.providers["xtalpi-pi-tools"].apiKey === key, "xtalpi configure must store the supplied key");
    assert(written.providers.codex.localOnly === true, "xtalpi configure must preserve unrelated providers");

    const unchanged = configureXtalpiModels({ agentDir, repoRoot, apiKey: key });
    assert(!unchanged.changed, "repeating xtalpi configure with the same key must be idempotent");

    const driftAgentDir = path.join(tmpRoot, "drift-agent");
    fs.mkdirSync(driftAgentDir, { recursive: true });
    const drifted = JSON.parse(JSON.stringify(example));
    drifted.providers["xtalpi-pi-tools"].baseUrl = "https://wrong.invalid/v1";
    drifted.providers["xtalpi-pi-tools"].api = "openai-completions";
    drifted.providers["xtalpi-pi-tools"].models = [{ id: "private-extra-model", name: "Keep me" }];
    drifted.providers["xtalpi-pi-tools"].apiKey = key;
    fs.writeFileSync(path.join(driftAgentDir, "models.json"), `${JSON.stringify(drifted, null, 2)}\n`);
    const repaired = configureXtalpiModels({ agentDir: driftAgentDir, repoRoot });
    const repairedModels = JSON.parse(fs.readFileSync(path.join(driftAgentDir, "models.json"), "utf8"));
    const repairedProvider = repairedModels.providers["xtalpi-pi-tools"];
    assert(repaired.changed, "xtalpi configure must repair canonical provider drift");
    assert(repairedProvider.baseUrl === example.providers["xtalpi-pi-tools"].baseUrl, "baseUrl drift was not repaired");
    assert(repairedProvider.api === example.providers["xtalpi-pi-tools"].api, "API family drift was not repaired");
    assert(
      repairedProvider.models.some((model) => model.id === "deepseek-v4-pro") &&
        repairedProvider.models.some((model) => model.id === "private-extra-model"),
      "canonical model repair must preserve extra local models",
    );

    const invalidRootAgentDir = path.join(tmpRoot, "invalid-root-agent");
    fs.mkdirSync(invalidRootAgentDir, { recursive: true });
    const invalidRootFile = path.join(invalidRootAgentDir, "models.json");
    fs.writeFileSync(invalidRootFile, "[]\n");
    let invalidRootRejected = false;
    try {
      configureXtalpiModels({ agentDir: invalidRootAgentDir, repoRoot, apiKey: key });
    } catch (error) {
      invalidRootRejected = String(error?.message || error).includes("models JSON root must be an object");
    }
    assert(invalidRootRejected, "xtalpi configure must reject a non-object models.json root");
    assert(fs.readFileSync(invalidRootFile, "utf8") === "[]\n", "invalid models.json must remain unchanged");

    const invalidKeyAgentDir = path.join(tmpRoot, "invalid-key-agent");
    fs.mkdirSync(invalidKeyAgentDir, { recursive: true });
    const invalidKeyModels = JSON.parse(JSON.stringify(example));
    invalidKeyModels.providers["xtalpi-pi-tools"].apiKey = { unexpected: true };
    fs.writeFileSync(
      path.join(invalidKeyAgentDir, "models.json"),
      `${JSON.stringify(invalidKeyModels, null, 2)}\n`,
    );
    let invalidKeyRejected = false;
    try {
      configureXtalpiModels({ agentDir: invalidKeyAgentDir, repoRoot });
    } catch (error) {
      invalidKeyRejected = String(error?.message || error).includes("apiKey must be a string");
    }
    assert(invalidKeyRejected, "xtalpi configure must reject a non-string existing API key");

    const replaceDir = path.join(tmpRoot, "replace-fallback");
    fs.mkdirSync(replaceDir, { recursive: true });
    const replaceSource = path.join(replaceDir, "source.tmp");
    const replaceTarget = path.join(replaceDir, "target.json");
    fs.writeFileSync(replaceSource, "new");
    fs.writeFileSync(replaceTarget, "old");
    let simulatedWindowsFailure = true;
    const replaceResult = replaceFileSafely(replaceSource, replaceTarget, {
      renameSync(source, target) {
        if (simulatedWindowsFailure && source === replaceSource && target === replaceTarget) {
          simulatedWindowsFailure = false;
          const error = new Error("simulated Windows existing-target rename failure");
          error.code = "EPERM";
          throw error;
        }
        fs.renameSync(source, target);
      },
    });
    assert(replaceResult.usedWindowsFallback, "safe replacement must exercise the Windows rollback fallback");
    assert(fs.readFileSync(replaceTarget, "utf8") === "new", "safe replacement did not install the new file");
    assert(!fs.existsSync(replaceSource), "safe replacement left the source temp file behind");

    const decodedBe = decodeJsonDocument(
      swapUtf16ForTest(Buffer.from('{"ok":true}', "utf16le"), true),
      "utf16be-self-test.json",
    );
    assert(decodedBe.value.ok === true, "xtalpi JSON reader must support UTF-16BE with BOM");

    const cliAgentDir = path.join(tmpRoot, "cli-agent");
    fs.mkdirSync(cliAgentDir, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "models.example.json"), path.join(cliAgentDir, "models.json"));
    const cliSecret = "xtalpi-cli-secret-should-not-leak";
    const cli = spawnSync(process.execPath, [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      cliAgentDir,
      "--repo-root",
      repoRoot,
      "xtalpi",
      "configure",
      "--no-prompt",
      "--json",
    ], {
      cwd: root,
      env: { ...process.env, PI67_XTALPI_API_KEY: cliSecret },
      encoding: "utf8",
    });
    assert(cli.status === 0, `xtalpi configure CLI failed\n${cli.stderr || cli.stdout}`);
    assert(!`${cli.stdout}\n${cli.stderr}`.includes(cliSecret), "xtalpi configure must never print the API key");
    const cliPayload = JSON.parse(cli.stdout);
    assert(cliPayload.configured === true && cliPayload.changed === true, "xtalpi configure JSON result is incomplete");

    const missingAgentDir = path.join(tmpRoot, "missing-agent");
    fs.mkdirSync(missingAgentDir, { recursive: true });
    const missing = spawnSync(process.execPath, [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      missingAgentDir,
      "--repo-root",
      repoRoot,
      "xtalpi",
      "configure",
      "--no-prompt",
      "--json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        PI67_XTALPI_API_KEY: "",
        PI67_XTALPI_PI_TOOLS_API_KEY: "",
        PI67_XTALPI_TOOLS_API_KEY: "",
      },
      encoding: "utf8",
    });
    assert(missing.status === 0, `non-interactive configure must allow a missing key\n${missing.stderr}`);
    const missingPayload = JSON.parse(missing.stdout);
    assert(
      missingPayload.configured === false &&
        missingPayload.changed === false &&
        missingPayload.skipped === true &&
        missingPayload.verification === null,
      `missing-key configure must report a successful no-op\n${missing.stdout}`,
    );
    for (const file of ["models.json", "settings.json", "auth.json"]) {
      assert(!fs.existsSync(path.join(missingAgentDir, file)), `missing-key configure must not create ${file}`);
    }

    const missingDryRun = spawnSync(process.execPath, [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      missingAgentDir,
      "--repo-root",
      repoRoot,
      "xtalpi",
      "configure",
      "--dry-run",
      "--no-prompt",
      "--json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        PI67_XTALPI_API_KEY: "",
        PI67_XTALPI_PI_TOOLS_API_KEY: "",
        PI67_XTALPI_TOOLS_API_KEY: "",
      },
      encoding: "utf8",
    });
    assert(missingDryRun.status === 0, `missing-key dry-run failed\n${missingDryRun.stderr}`);
    const missingDryRunPayload = JSON.parse(missingDryRun.stdout);
    assert(
      missingDryRunPayload.configured === false &&
        missingDryRunPayload.changed === false &&
        missingDryRunPayload.skipped === true &&
        missingDryRunPayload.dryRun === true,
      `missing-key dry-run contract is incomplete\n${missingDryRun.stdout}`,
    );

    const forbiddenCliSecret = "xtalpi-cli-secret-must-not-appear";
    const forbiddenOption = spawnSync(process.execPath, [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      missingAgentDir,
      "--repo-root",
      repoRoot,
      "xtalpi",
      "configure",
      "--api-key",
      forbiddenCliSecret,
    ], {
      cwd: root,
      encoding: "utf8",
    });
    assert(forbiddenOption.status === 2, "xtalpi configure must reject a plaintext --api-key option");
    assert(
      forbiddenOption.stderr.includes("unknown option: --api-key") &&
        !`${forbiddenOption.stdout}\n${forbiddenOption.stderr}`.includes(forbiddenCliSecret),
      "rejected plaintext key options must not echo their value",
    );

    const positionalSecret = "xtalpi-positional-secret-must-not-appear";
    const forbiddenPositional = spawnSync(process.execPath, [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      missingAgentDir,
      "--repo-root",
      repoRoot,
      "xtalpi",
      "configure",
      positionalSecret,
    ], {
      cwd: root,
      encoding: "utf8",
    });
    assert(forbiddenPositional.status === 2, "xtalpi configure must reject positional key values");
    assert(
      forbiddenPositional.stderr.includes("does not accept positional values") &&
        !`${forbiddenPositional.stdout}\n${forbiddenPositional.stderr}`.includes(positionalSecret),
      "rejected positional key values must not be echoed",
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runProviderStatusSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-provider-status-"));
  const repoRoot = path.resolve(root, "../..");
  const script = path.join(repoRoot, "scripts", "pi67-provider-status.mjs");
  const baseModels = JSON.parse(fs.readFileSync(path.join(repoRoot, "models.example.json"), "utf8"));

  const runFixture = ({ name, provider, model, auth = {}, env = {} }) => {
    const agentDir = path.join(tmpRoot, name);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ defaultProvider: provider, defaultModel: model }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(baseModels, null, 2)}\n`);
    if (auth !== null) {
      fs.writeFileSync(path.join(agentDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`);
    }
    const result = spawnSync(process.execPath, [
      script,
      "--agent-dir",
      agentDir,
      "--repo-root",
      repoRoot,
      "--json",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        XTALPI_PI_TOOLS_API_KEY: "",
        XTALPI_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        ...env,
      },
      encoding: "utf8",
    });
    assert(result.status === 0, `${name} provider status failed\n${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  };

  try {
    const zeroKey = runFixture({
      name: "xtalpi-zero-key",
      provider: "xtalpi-pi-tools",
      model: "deepseek-v4-pro",
      auth: null,
    });
    assert(zeroKey.piStartupReady === true, "missing xtalpi key must not block Pi startup readiness");
    assert(zeroKey.modelRequestReady === false, "missing xtalpi key must keep model request readiness false");
    assert(zeroKey.persistenceOwner === "upstream-pi", "provider status must preserve upstream persistence ownership");

    const xtalpiAuth = runFixture({
      name: "xtalpi-auth",
      provider: "xtalpi-pi-tools",
      model: "deepseek-v4-pro",
      auth: { "xtalpi-pi-tools": { type: "api_key", key: "fixture-xtalpi-key" } },
    });
    assert(
      xtalpiAuth.modelRequestReady === true && xtalpiAuth.credentialSource === "auth.json",
      "upstream /login auth must make xtalpi request-ready without pi-67 persistence",
    );

    const deepseekAuth = runFixture({
      name: "deepseek-auth",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      auth: { deepseek: { type: "api_key", key: "fixture-deepseek-key" } },
    });
    assert(
      deepseekAuth.kind === "builtin" &&
        deepseekAuth.modelRequestReady === true &&
        deepseekAuth.persistenceOwner === "upstream-pi",
      "DeepSeek readiness must remain an upstream Pi-owned contract",
    );

    const upstream = runFixture({
      name: "other-upstream",
      provider: "anthropic",
      model: "claude-fixture",
      auth: {},
    });
    assert(
      upstream.piStartupReady === true &&
        upstream.kind === "upstream" &&
        upstream.modelRequestReady === false,
      "uninspected upstream providers must not become a Pi startup failure",
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function swapUtf16ForTest(buffer, includeBom = false) {
  const swapped = Buffer.alloc(buffer.length + (includeBom ? 2 : 0));
  let offset = 0;
  if (includeBom) {
    swapped[0] = 0xfe;
    swapped[1] = 0xff;
    offset = 2;
  }
  for (let index = 0; index < buffer.length; index += 2) {
    swapped[offset + index] = buffer[index + 1];
    swapped[offset + index + 1] = buffer[index];
  }
  return swapped;
}

function runInstallNonGitAgentDirSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-install-non-git-"));
  const home = path.join(tmpRoot, "home");
  const agentDir = path.join(tmpRoot, "agent");
  const skillsDir = path.join(tmpRoot, "skills");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const baseArgs = [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      agentDir,
      "--repo-root",
      agentDir,
      "--skills-dir",
      skillsDir,
      "install",
      "--repo",
      "https://example.invalid/pi-67.git",
    ];

    const blocked = spawnSync(process.execPath, baseArgs, { cwd: root, env, encoding: "utf8" });
    assert(blocked.status !== 0, "non-git agent dir install must block by default");
    assert(
      blocked.stderr.includes("agent dir exists but is not a git checkout") &&
        blocked.stderr.includes("pi-67 install --repair --yes --dry-run"),
      `non-git agent dir error must include actionable repair guidance\n${blocked.stderr}`,
    );

    const preview = spawnSync(process.execPath, [...baseArgs, "--repair", "--yes", "--dry-run"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert(preview.status === 0, `non-git agent dir repair dry-run failed\n${preview.stderr || preview.stdout}`);
    assert(
      preview.stdout.includes("DRY-RUN would move existing non-git agent dir") &&
        preview.stdout.includes("git clone https://example.invalid/pi-67.git"),
      `repair dry-run must preview backup move and clone\n${preview.stdout}`,
    );
    assert(fs.existsSync(path.join(agentDir, "settings.json")), "repair dry-run must not move the existing non-git folder");

    const noGitEnv = {
      ...env,
      PATH: "",
      Path: "",
      PI67_GIT_EXE: "",
      ProgramW6432: "",
      ProgramFiles: "",
      "ProgramFiles(x86)": "",
      LOCALAPPDATA: path.join(tmpRoot, "no-localappdata"),
      LocalAppData: path.join(tmpRoot, "no-localappdata"),
      ChocolateyInstall: "",
    };
    const noGitRepair = spawnSync(process.execPath, [...baseArgs, "--repair", "--yes"], {
      cwd: root,
      env: noGitEnv,
      encoding: "utf8",
    });
    assert(noGitRepair.status !== 0, "repair install must fail when git is not available");
    assert(
      noGitRepair.stderr.includes("git is required before pi-67 can clone") &&
        noGitRepair.stderr.includes("git --version") &&
        noGitRepair.stderr.includes("pi-67 install --repair --yes"),
      `missing git error must be actionable\n${noGitRepair.stderr}`,
    );
    assert(fs.existsSync(path.join(agentDir, "settings.json")), "missing git repair must not move the existing non-git folder");
    const backupRoot = path.join(home, ".pi", "pi67", "backups");
    assert(
      !fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0,
      "missing git repair must not create non-git takeover backups before clone is possible",
    );

    const emptyAgentDir = path.join(tmpRoot, "empty-agent");
    fs.mkdirSync(emptyAgentDir, { recursive: true });
    const emptyPreview = spawnSync(process.execPath, [
      path.join(root, "bin", "pi-67.mjs"),
      "--agent-dir",
      emptyAgentDir,
      "--repo-root",
      emptyAgentDir,
      "--skills-dir",
      skillsDir,
      "install",
      "--repo",
      "https://example.invalid/pi-67.git",
      "--dry-run",
    ], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert(emptyPreview.status === 0, `empty agent dir install dry-run should be allowed\n${emptyPreview.stderr || emptyPreview.stdout}`);
    assert(
      emptyPreview.stdout.includes("agent dir exists and is empty") &&
        emptyPreview.stdout.includes("git clone https://example.invalid/pi-67.git"),
      `empty agent dir dry-run must preview clone into existing empty directory\n${emptyPreview.stdout}`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runVersionRecommendationSelfTests() {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) return;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-version-recommendation-"));
  const home = path.join(tmpRoot, "home");
  const repo = path.join(tmpRoot, "agent");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "VERSION"), "0.10.0\n");
  fs.writeFileSync(path.join(repo, "settings.json"), "{\n  \"lastChangelogVersion\": \"0.80.3\",\n  \"theme\": \"gruvbox-dark\"\n}\n");
  for (const args of [
    ["-C", repo, "init", "-q"],
    ["-C", repo, "config", "user.email", "pi67-check@example.invalid"],
    ["-C", repo, "config", "user.name", "pi67-check"],
    ["-C", repo, "add", "VERSION", "settings.json"],
    ["-C", repo, "commit", "-q", "-m", "init"],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert(result.status === 0, `git setup failed for version recommendation self-test: git ${args.join(" ")}\n${result.stderr}`);
  }
  fs.writeFileSync(path.join(repo, "settings.json"), "{\n  \"lastChangelogVersion\": \"0.80.4\",\n  \"theme\": \"gruvbox-dark\"\n}\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const result = spawnSync(process.execPath, [
    path.join(root, "bin", "pi-67.mjs"),
    "--agent-dir",
    repo,
    "--repo-root",
    repo,
    "--no-remote",
    "version",
  ], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert(result.status === 0, `version recommendation command failed\n${result.stderr || result.stdout}`);
  assert(
    result.stdout.includes("npm install updated only the manager package") &&
      result.stdout.includes("update --repair") &&
      result.stdout.includes("settings.json has Pi runtime changelog marker state"),
    `version output must explain manager/distro mismatch and runtime marker repair\n${result.stdout}`,
  );
  const json = spawnSync(process.execPath, [
    path.join(root, "bin", "pi-67.mjs"),
    "--agent-dir",
    repo,
    "--repo-root",
    repo,
    "--no-remote",
    "version",
    "--json",
  ], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert(json.status === 0, `version --json recommendation command failed\n${json.stderr || json.stdout}`);
  const parsed = JSON.parse(json.stdout);
  assert(
    parsed.recommendations?.some((item) => item.message.includes("update --repair")),
    "version --json must include actionable recommendations",
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function runUpstreamPiRuntimeSelfTests() {
  const manifest = {
    upstreamPi: {
      packageName: "@earendil-works/pi-coding-agent",
      command: "pi",
      testedVersion: "0.80.6",
      compatibilityPolicy: "warn-if-installed-behind-release-tested-version",
      updateCommand: "npm install -g @earendil-works/pi-coding-agent@latest",
    },
  };
  const behind = await inspectUpstreamPiRuntime({}, {
    manifest,
    captureCommand: () => ({ ok: true, stdout: "0.80.3\n", stderr: "" }),
    registryOptions: {
      fetchImpl: async () => jsonResponse(200, { version: "0.80.6" }),
    },
  });
  assert(behind.installedVersion === "0.80.3", "upstream Pi inspection must parse the installed version");
  assert(behind.testedVersion === "0.80.6", "upstream Pi inspection must expose the release-tested version");
  assert(behind.installedBehindTested, "upstream Pi inspection must detect a runtime behind the tested baseline");
  assert(behind.registry.outdated, "upstream Pi inspection must detect a registry update");
  assert(
    upstreamPiCheck(behind).level === "WARN" && upstreamPiCheck(behind).message.includes("release-tested 0.80.6"),
    "upstream Pi doctor check must warn when the installed runtime is behind the tested baseline",
  );

  const current = await inspectUpstreamPiRuntime({}, {
    manifest,
    captureCommand: () => ({ ok: true, stdout: "pi 0.80.6\n", stderr: "" }),
    noRemote: true,
  });
  assert(current.compatibility === "release-tested", "matching upstream Pi must satisfy the tested baseline");
  assert(upstreamPiCheck(current).level === "PASS", "matching upstream Pi must pass the doctor check");
  assert(current.registry.skipped, "no-remote upstream Pi inspection must skip the npm registry");

  const missing = await inspectUpstreamPiRuntime({}, {
    manifest,
    captureCommand: () => ({ ok: false, stdout: "", stderr: "not found" }),
    noRemote: true,
  });
  assert(missing.compatibility === "missing-or-failed", "missing upstream Pi must be observable");
  assert(upstreamPiCheck(missing).level === "FAIL", "missing upstream Pi must fail the doctor check");
}

function runPublishTargetSelfTests() {
  const unpublished = {
    skipped: false,
    ok: false,
    message: "not published on npm registry yet",
  };
  const visibleScope = {
    skipped: false,
    ok: true,
    blocking: false,
    scoped: true,
    scope: "@example",
    message: "visible",
  };
  const missingScope = {
    skipped: false,
    ok: false,
    blocking: true,
    scoped: true,
    scope: "@example",
    code: "scope_missing",
    message: "missing",
  };
  assert(
    npmPublishTargetStatus("@example/pkg", { registry: unpublished, scope: visibleScope }).code ===
      "first_publish_requires_confirmation",
    "first publish must require explicit confirmation",
  );
  assert(
    npmPublishTargetStatus("@example/pkg", {
      registry: unpublished,
      scope: visibleScope,
      allowFirstPublish: true,
    }).ok,
    "confirmed first publish with visible scope should pass the local target gate",
  );
  assert(
    npmPublishTargetStatus("@example/pkg", {
      registry: unpublished,
      scope: missingScope,
    }).blocking,
    "missing scope must block unconfirmed first publish",
  );
  assert(
    npmPublishTargetStatus("@example/pkg", {
      registry: unpublished,
      scope: missingScope,
      allowFirstPublish: true,
    }).code === "first_publish_scope_probe_confirmed",
    "explicit first-publish confirmation should allow npm publish to be the authority for a new scope",
  );
}

async function runNpmRegistrySelfTests() {
  assert(
    npmRegistryPackageUrl("@bigking67/pi-67") === "https://registry.npmjs.org/@bigking67%2Fpi-67/latest",
    "scoped npm package registry URL must use the direct registry endpoint",
  );
  const current = await npmLatestVersion("@example/pkg", {
    currentVersion: "0.9.0",
    fetchImpl: async () => jsonResponse(200, { version: "1.2.3" }),
  });
  assert(current.ok && current.latestVersion === "1.2.3" && current.outdated, "direct registry latest lookup must parse version payloads");
  assert(versionFromRange("^0.33.1") === "0.33.1", "versionFromRange must read caret baselines");
  assert(!versionSatisfiesSupportedRange("0.34.0", "^0.33.1"), "caret zero-minor range must not accept the next minor");
  assert(versionSatisfiesSupportedRange("0.33.2", "^0.33.1"), "caret zero-minor range must accept patch updates");
  assert(versionSatisfiesSupportedRange("5.1.0", "^5.0.2"), "caret non-zero-major range must accept same-major updates");
  assert(!versionSatisfiesSupportedRange("6.0.0", "^5.0.2"), "caret non-zero-major range must reject next major");

  const missing = await npmLatestVersion("@example/missing", {
    fetchImpl: async () => jsonResponse(404, { error: "not found" }),
  });
  assert(missing.message === "not published on npm registry yet", "direct registry 404 must classify unpublished packages");

  const malformed = await npmLatestVersion("@example/bad", {
    fetchImpl: async () => jsonResponse(200, { name: "@example/bad" }),
  });
  assert(!malformed.ok && malformed.message === "npm registry returned no version", "direct registry malformed payloads must fail closed");

  const invalidJson = await npmLatestVersion("@example/invalid-json", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        throw new SyntaxError("Unexpected token");
      },
    }),
  });
  assert(invalidJson.message === "npm registry returned invalid JSON", "direct registry invalid JSON must be classified");

  const timeout = await npmLatestVersion("@example/slow", {
    fetchImpl: async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  assert(timeout.message === "npm registry lookup timed out", "direct registry aborts must classify as timeouts");
}

function runShellRunnerSelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-shell-runner-"));
  const fakeProgramFiles = path.join(tmpRoot, "Program Files");
  const fakeGitExe = path.join(fakeProgramFiles, "Git", "cmd", "git.exe");
  fs.mkdirSync(path.dirname(fakeGitExe), { recursive: true });
  fs.writeFileSync(fakeGitExe, "");
  const fakeEnv = { PATH: "", ProgramFiles: fakeProgramFiles };
  assert(
    JSON.stringify(commandCandidatesForPlatform("npm", "win32")) === JSON.stringify(["npm", "npm.cmd", "cmd.exe"]),
    "Windows npm execution must fall back through npm.cmd and cmd.exe",
  );
  assert(
    JSON.stringify(commandCandidatesForPlatform("npx", "win32")) === JSON.stringify(["npx", "npx.cmd", "cmd.exe"]),
    "Windows npx execution must fall back through npx.cmd and cmd.exe",
  );
  assert(
    JSON.stringify(commandCandidatesForPlatform("pi", "win32")) === JSON.stringify(["pi", "pi.cmd", "cmd.exe"]),
    "Windows pi execution must fall back through pi.cmd and cmd.exe",
  );
  for (const command of ["npm", "npx", "pi"]) {
    const invocations = [];
    const outcome = spawnCommandWithFallback(command, ["--version"], {
      platform: "win32",
      env: { ComSpec: "cmd.exe" },
      encoding: "utf8",
      spawnImpl(candidate, args) {
        invocations.push({ candidate, args });
        if (invocations.length === 1) {
          return spawnFailure("ENOENT", `${candidate} was not resolved directly`);
        }
        if (invocations.length === 2) {
          return spawnFailure("EINVAL", `${candidate} requires cmd.exe`);
        }
        return { status: 0, stdout: "ok\n", stderr: "" };
      },
    });
    assert(outcome.result.status === 0, `Windows ${command} shim fallback must reach cmd.exe`);
    assert(
      invocations.length === 3 && invocations[2].candidate === "cmd.exe",
      `Windows ${command} EINVAL must continue to the cmd.exe fallback`,
    );
    assert(
      JSON.stringify(invocations[2].args.slice(0, 4)) === JSON.stringify(["/d", "/s", "/c", `${command}.cmd`]),
      `Windows ${command} cmd.exe fallback arguments drifted`,
    );
  }
  const nonzeroInvocations = [];
  const nonzero = spawnCommandWithFallback("pi", ["--version"], {
    platform: "win32",
    env: { ComSpec: "cmd.exe" },
    spawnImpl(candidate) {
      nonzeroInvocations.push(candidate);
      return { status: 7, stdout: "", stderr: "upstream failure" };
    },
  });
  assert(nonzero.result.status === 7, "real upstream pi exit codes must be preserved");
  assert(nonzeroInvocations.length === 1, "real upstream pi failures must not trigger shim fallback");
  try {
    assert(
      JSON.stringify(commandCandidatesForPlatform("git", "win32", fakeEnv)) === JSON.stringify(["git", "git.exe", fakeGitExe]),
      "Windows git execution must include installed Git for Windows fallback paths",
    );
    assert(
      findWindowsGitExecutable(fakeEnv, "win32") === fakeGitExe,
      "Windows git executable discovery must find common Git for Windows locations",
    );
    const patchedEnv = envWithWindowsGitFallback(fakeEnv, "win32");
    assert(
      patchedEnv.PATH.startsWith(path.dirname(fakeGitExe)),
      "Windows git fallback must prepend the discovered Git directory to PATH",
    );
    const repairEnv = { PATH: "", ProgramFiles: fakeProgramFiles };
    const dryRepair = repairWindowsGitPath({
      env: repairEnv,
      platform: "win32",
      persistUserPath: true,
      dryRun: true,
    });
    assert(
      dryRepair.found && dryRepair.processPathPatched && repairEnv.PATH.startsWith(path.dirname(fakeGitExe)),
      "Windows git repair must patch the current process PATH before clone/install commands run",
    );
    assert(
      dryRepair.persistence.dryRun,
      "Windows git repair dry-run must not persist User PATH",
    );
    const persisted = persistWindowsUserPathDirectory(path.dirname(fakeGitExe), {
      platform: "win32",
      powerShellCommands: ["powershell.exe"],
      spawnImpl(command, args, options) {
        assert(command === "powershell.exe", "Windows user PATH persistence must use the provided PowerShell command");
        assert(args.includes("-EncodedCommand"), "Windows user PATH persistence must avoid shell-interpolated script text");
        assert(
          options.env.PI67_GIT_DIR_TO_PERSIST === path.dirname(fakeGitExe),
          "Windows user PATH persistence must pass the Git directory through environment, not command text",
        );
        return { status: 0, stdout: "updated\nbroadcasted\n", stderr: "" };
      },
    });
    assert(
      persisted.ok && persisted.persisted && persisted.broadcasted && !persisted.alreadyPresent,
      "Windows user PATH persistence must report successful updates and environment broadcasts",
    );
    const alreadyPresent = persistWindowsUserPathDirectory(path.dirname(fakeGitExe), {
      platform: "win32",
      powerShellCommands: ["powershell.exe"],
      spawnImpl() {
        return { status: 0, stdout: "already-present\n", stderr: "" };
      },
    });
    assert(
      alreadyPresent.ok && !alreadyPresent.persisted && alreadyPresent.alreadyPresent,
      "Windows user PATH persistence must report already-present directories as no-op success",
    );
    assert(
      JSON.stringify(commandCandidatesForPlatform("npm", "darwin")) === JSON.stringify(["npm"]),
      "POSIX npm execution should keep the requested command",
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function spawnFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return { status: null, stdout: "", stderr: "", error };
}

function runExtensionRegistrySelfTests() {
  const registry = readExtensionRegistry(path.join(root, "src", "data", "extension-registry.json"));
  const manifest = extensionRegistryTestManifest();
  assert(
    validateExtensionRegistry(registry).ok,
    "current extension registry must pass standalone policy validation",
  );
  assert(
    validateExtensionRegistry(registry, { manifest }).ok,
    "current extension registry must pass policy validation",
  );

  const duplicate = clone(registry);
  duplicate.extensions.push({ ...duplicate.extensions[0] });
  assert(
    validateExtensionRegistry(duplicate, { manifest }).problems.some((item) => item.includes("duplicate extension registry id")),
    "duplicate extension registry ids must fail",
  );

  const missingSmoke = mutateExtension(registry, "xtalpi-pi-tools", (entry) => {
    entry.smoke = [];
  });
  assert(
    validateExtensionRegistry(missingSmoke, { manifest }).problems.some((item) => item.includes("smoke gate")),
    "extensions without smoke gates must fail",
  );

  const forbiddenBehavior = mutateExtension(registry, "xtalpi-pi-tools", (entry) => {
    entry.updateStrategy = "overwrite-user-config";
  });
  assert(
    validateExtensionRegistry(forbiddenBehavior, { manifest }).problems.some((item) => item.includes("forbidden behavior")),
    "forbidden update behavior must fail",
  );

  const unsupportedPatchMode = mutateExtension(registry, "xtalpi-pi-tools", (entry) => {
    entry.configPatches[0].mode = "overwrite";
  });
  assert(
    validateExtensionRegistry(unsupportedPatchMode, { manifest }).problems.some((item) => item.includes("unsupported config patch mode")),
    "unsupported config patch modes must fail",
  );

  const themePolicyDriftManifest = {
    ...manifest,
    theme: { policy: "select-theme-during-update" },
  };
  assert(
    validateExtensionRegistry(registry, { manifest: themePolicyDriftManifest }).problems.some((item) => item.includes("theme extension registry policy")),
    "theme policy drift must fail",
  );

  const unsafeThemePatch = mutateExtension(registry, "pi-curated-themes", (entry) => {
    entry.configPatches = [{ file: "settings.json", path: "theme", mode: "merge-preserve" }];
  });
  assert(
    validateExtensionRegistry(unsafeThemePatch, { manifest }).problems.some((item) => item.includes("only report current theme")),
    "theme update must not patch selected theme",
  );

  const safeThemeReportOnly = mutateExtension(registry, "pi-curated-themes", (entry) => {
    entry.configPatches = [{ file: "settings.json", path: "theme", mode: "report-only" }];
  });
  assert(
    validateExtensionRegistry(safeThemeReportOnly, { manifest }).ok,
    "theme registry may report settings.json theme only when it does not patch it",
  );

  const sharedSkillDriftManifest = {
    ...manifest,
    sharedSkills: { policy: "overwrite-different-shared-skill" },
  };
  assert(
    validateExtensionRegistry(registry, { manifest: sharedSkillDriftManifest }).problems.some((item) => item.includes("shared-skills extension registry policy")),
    "shared skill policy drift must fail",
  );

  const externalDirtyDrift = mutateExtension(registry, "browser67", (entry) => {
    entry.updateStrategy = "git-pull-even-when-dirty";
  });
  assert(
    validateExtensionRegistry(externalDirtyDrift, { manifest }).problems.some((item) => item.includes("must block dirty updates")),
    "dirty external repo update drift must fail",
  );

  const missingManagedManifest = {
    ...manifest,
    localExtensions: [...manifest.localExtensions, { name: "missing-managed-extension", owner: "pi67-managed" }],
  };
  assert(
    validateExtensionRegistry(registry, { manifest: missingManagedManifest }).problems.some((item) => item.includes("managed local extension missing registry entry")),
    "managed local extensions must be registered",
  );
}

function runSettingsRuntimeStateSelfTests() {
  const input = "{\n  \"lastChangelogVersion\": \"0.80.3\",\n  \"theme\": \"gruvbox-dark\"\n}\n";
  const stripped = JSON.parse(stripSettingsRuntimeMarkerText(input));
  assert(
    stripped.lastChangelogVersion === undefined && stripped.theme === "gruvbox-dark",
    "settings runtime clean filter must remove only lastChangelogVersion",
  );
  const marker = settingsRuntimeMarkerFromObject({ lastChangelogVersion: "0.80.3" });
  const state = mergeSettingsRuntimeMarkerIntoState({ schema: "pi67.state.v1" }, marker, "2026-07-08T00:00:00.000Z");
  assert(
    state.runtimeMarkers?.lastChangelogVersion?.value === "0.80.3" &&
      state.runtimeMarkers.lastChangelogVersion.storage === "state.json",
    "settings runtime marker must migrate into state runtimeMarkers",
  );
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-settings-runtime-state-"));
  const agentDir = path.join(tmpRoot, "agent");
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{\r\n  \"theme\": \"gruvbox-dark\"\r\n}\r\n", "utf8");
  const lineEndingResult = migrateSettingsRuntimeState(
    { agentDir, repoRoot: agentDir, stateDir },
    { normalizeSettingsJson: true },
  );
  const normalizedSettings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
  assert(lineEndingResult.markerFound === false, "line-ending normalization must not require runtime marker");
  assert(lineEndingResult.settingsNormalized === true, "CRLF settings.json must be normalized under --normalize");
  assert(
    lineEndingResult.settingsNormalizeReasons.includes("line-endings"),
    "settings normalization must classify CRLF as line-endings",
  );
  assert(
    normalizedSettings === "{\n  \"theme\": \"gruvbox-dark\"\n}\n",
    "settings line-ending normalization must preserve JSON content and indentation",
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0) {
    const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-settings-index-refresh-"));
    const gitStateDir = path.join(gitRoot, "state");
    fs.writeFileSync(path.join(gitRoot, ".gitattributes"), "settings.json text eol=lf\n");
    fs.writeFileSync(path.join(gitRoot, "settings.json"), "{\n  \"theme\": \"gruvbox-dark\"\n}\n");
    for (const args of [
      ["-C", gitRoot, "init", "-q"],
      ["-C", gitRoot, "config", "user.email", "pi67-check@example.invalid"],
      ["-C", gitRoot, "config", "user.name", "pi67-check"],
      ["-C", gitRoot, "add", ".gitattributes", "settings.json"],
      ["-C", gitRoot, "commit", "-q", "-m", "init"],
    ]) {
      const result = spawnSync("git", args, { encoding: "utf8" });
      assert(result.status === 0, `git setup failed for settings index refresh self-test: git ${args.join(" ")}\n${result.stderr}`);
    }
    fs.writeFileSync(path.join(gitRoot, "settings.json"), "{\r\n  \"theme\": \"gruvbox-dark\"\r\n}\r\n");
    const statusBefore = spawnSync("git", ["-C", gitRoot, "status", "--short", "--", "settings.json"], { encoding: "utf8" });
    const diffBefore = spawnSync("git", ["-C", gitRoot, "diff", "--quiet", "--", "settings.json"], { encoding: "utf8" });
    assert(statusBefore.stdout.includes("settings.json"), "settings index refresh self-test must start with false-dirty status");
    assert(diffBefore.status === 0, "settings index refresh self-test must have no real content diff");
    const refreshResult = refreshSettingsGitIndex({ agentDir: gitRoot, repoRoot: gitRoot, stateDir: gitStateDir });
    const statusAfter = spawnSync("git", ["-C", gitRoot, "status", "--short", "--", "settings.json"], { encoding: "utf8" });
    assert(refreshResult.refreshed === true, "settings index refresh must classify cleared false-dirty status");
    assert(!statusAfter.stdout.trim(), `settings index refresh must clear false-dirty status\n${statusAfter.stdout}`);
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
}

function runUpdatePreflightMigrationSelfTests() {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) return;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-update-preflight-migration-"));
  const home = path.join(tmpRoot, "home");
  const repo = path.join(tmpRoot, "agent");
  const skillsDir = path.join(tmpRoot, "skills");
  const packagesDir = path.join(tmpRoot, "packages");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(packagesDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "VERSION"), "0.10.0\n");
  fs.writeFileSync(path.join(repo, "settings.json"), "{\n  \"theme\": \"gruvbox-dark\"\n}\n");
  fs.writeFileSync(path.join(repo, "scripts", "pi67-update.sh"), `#!/usr/bin/env bash
set -euo pipefail
agent_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir)
      agent_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if grep -q "lastChangelogVersion" "$agent_dir/settings.json"; then
  echo "marker still present before distro script" >&2
  exit 44
fi
`);
  fs.writeFileSync(path.join(repo, "scripts", "pi67-update.ps1"), `param(
  [string]$AgentDir,
  [string]$RepoRoot,
  [string]$SkillsDir,
  [switch]$DryRun,
  [switch]$ForceNpm,
  [switch]$NoNpm,
  [switch]$AllowDirty,
  [switch]$StrictSharedSkills
)
$settings = Get-Content -LiteralPath (Join-Path $AgentDir "settings.json") -Raw
if ($settings -match "lastChangelogVersion") {
  Write-Error "marker still present before distro script"
  exit 44
}
`);
  for (const args of [
    ["-C", repo, "init", "-q"],
    ["-C", repo, "config", "user.email", "pi67-check@example.invalid"],
    ["-C", repo, "config", "user.name", "pi67-check"],
    ["-C", repo, "add", "VERSION", "settings.json", "scripts/pi67-update.sh", "scripts/pi67-update.ps1"],
    ["-C", repo, "commit", "-q", "-m", "init"],
  ]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert(result.status === 0, `git setup failed for update preflight migration self-test: git ${args.join(" ")}\n${result.stderr}`);
  }
  fs.writeFileSync(path.join(repo, "settings.json"), "{\n  \"lastChangelogVersion\": \"0.80.4\",\n  \"theme\": \"gruvbox-dark\"\n}\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const result = spawnSync(process.execPath, [
    path.join(root, "bin", "pi-67.mjs"),
    "--agent-dir",
    repo,
    "--repo-root",
    repo,
    "--skills-dir",
    skillsDir,
    "--packages-dir",
    packagesDir,
    "update",
    "--repair",
    "--no-remote",
    "--no-npm",
  ], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert(
    result.status === 0,
    `update must preflight-normalize settings runtime marker before calling the distro script\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert(
    result.stdout.includes("Preflight: Migrated settings.json lastChangelogVersion") &&
      result.stdout.includes("Preflight: Normalized settings.json"),
    `update output must report preflight runtime marker migration\n${result.stdout}`,
  );
  const settings = JSON.parse(fs.readFileSync(path.join(repo, "settings.json"), "utf8"));
  assert(settings.lastChangelogVersion === undefined, "update preflight migration must remove lastChangelogVersion from settings.json");
  const state = JSON.parse(fs.readFileSync(path.join(home, ".pi", "pi67", "state.json"), "utf8"));
  assert(
    state.runtimeMarkers?.lastChangelogVersion?.value === "0.80.4",
    "update preflight migration must persist lastChangelogVersion into ignored state",
  );
  const status = spawnSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" });
  assert(status.status === 0, `git status failed for update preflight migration self-test\n${status.stderr}`);
  assert(
    !status.stdout.split(/\r?\n/).some((line) => line.trim().endsWith("settings.json")),
    `settings.json should be clean after preflight marker migration\n${status.stdout}`,
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runUpdatePlanSelfTests() {
  assert(
    classifyGitShort(" M settings.json\n?? tmp.txt").preservedRuntime.includes("settings.json"),
    "git short classifier must identify preserved runtime config",
  );
  assert(
    classifyGitShort("M settings.json").preservedRuntime.includes("settings.json"),
    "git short classifier must tolerate status output whose first leading space was trimmed",
  );
  assert(
    classifyGitShort(" M README.md").unsafeTracked.includes("README.md"),
    "git short classifier must identify unsafe tracked edits",
  );

  const clean = decisionsFixture();
  assert(
    buildPlanDecisions(clean).blocked.length === 0,
    "clean repo must not be blocked",
  );

  const dirtyRuntime = decisionsFixture({
    git: { dirty: true, short: " M settings.json" },
  });
  const dirtyRuntimeDecisions = buildPlanDecisions(dirtyRuntime);
  assert(
    dirtyRuntimeDecisions.actions.some((item) => item.id === "user-runtime-config"),
    "dirty runtime config must be planned for backup/restore instead of overwrite",
  );
  assert(
    !dirtyRuntimeDecisions.blocked.some((item) => item.id === "repo-root"),
    "dirty runtime config alone must not block the distro update plan",
  );

  const dirtyRuntimeRemoteCurrent = decisionsFixture({
    git: { dirty: true, short: " M settings.json", commit: "abcdef123456" },
    remote: { ok: true, commit: "abcdef1234567890" },
  });
  const currentRemoteAction = buildPlanDecisions(dirtyRuntimeRemoteCurrent).actions.find((item) => item.id === "user-runtime-config");
  assert(
    currentRemoteAction?.operation === "preserve-in-place-no-backup" &&
      currentRemoteAction.createsNewBackup === false &&
      currentRemoteAction.writes.length === 0,
    "dirty runtime config must not plan a new backup when the remote already matches local HEAD",
  );

  const dirtyReadme = decisionsFixture({
    git: { dirty: true, short: " M README.md" },
  });
  assert(
    buildPlanDecisions(dirtyReadme).blocked.some((item) => item.id === "repo-root"),
    "non-runtime dirty tracked files must block the distro update plan",
  );

  const missingExtension = decisionsFixture({
    manifest: {
      localExtensions: [{ name: "xtalpi-pi-tools", owner: "pi67-managed", exists: false, path: "extensions/xtalpi-pi-tools" }],
    },
  });
  assert(
    buildPlanDecisions(missingExtension).actions.some((item) => item.id === "xtalpi-pi-tools"),
    "missing managed local extension must create a repair action",
  );

  const missingTheme = decisionsFixture({ theme: "current-theme", themeInstalled: false });
  const missingThemeDecisions = buildPlanDecisions(missingTheme);
  assert(
    missingThemeDecisions.actions.some((item) => item.id === "pi-curated-themes" && item.preserves.includes("settings.json.theme")),
    "missing theme assets must preserve selected theme while planning asset repair",
  );

  const sharedSkillConflict = decisionsFixture({
    skills: { summary: { missing: 0, conflicts: 2 } },
  });
  assert(
    buildPlanDecisions(sharedSkillConflict).warnings.some((item) => item.includes("preserved user-modified global skills")),
    "preserved user-modified shared skills must warn and preserve by default",
  );
  const strictSharedSkillConflict = decisionsFixture({
    strictSharedSkills: true,
    skills: { summary: { missing: 0, conflicts: 2 } },
  });
  assert(
    buildPlanDecisions(strictSharedSkillConflict).blocked.some((item) => item.id === "shared-skills"),
    "strict shared skill conflicts must block instead of overwriting",
  );

  const externalDirty = decisionsFixture({
    external: [{ name: "browser67", exists: true, path: "/tmp/browser67", git: { isRepo: true, dirty: true, branch: "main" } }],
  });
  assert(
    buildPlanDecisions(externalDirty).blocked.some((item) => item.id === "browser67"),
    "dirty external repos must block destructive external updates",
  );

  const managerOutdated = decisionsFixture({
    manager: { name: "@bigking67/pi-67", version: "0.10.24" },
    managerRegistry: { outdated: true },
  });
  assert(
    buildPlanDecisions(managerOutdated).actions.some((item) => item.id === "pi67-manager"),
    "outdated npm manager must produce an explicit self-update action",
  );
  assert(
    buildPlanDecisions(managerOutdated).blocked.some((item) => item.id === "pi67-manager"),
    "outdated npm manager must block distro update/repair until the manager is refreshed",
  );
  const managerBehindDistro = decisionsFixture({
    manager: { name: "@bigking67/pi-67", version: "0.10.24" },
    managerRegistry: { outdated: false },
    managerBehindLocalDistro: true,
    managerFreshness: {
      managerVersion: "0.10.24",
      distroVersion: "0.10.25",
      managerBehindLocalDistro: true,
      registryOutdated: false,
    },
  });
  assert(
    buildPlanDecisions(managerBehindDistro).blocked.some((item) => item.id === "pi67-manager"),
    "manager older than local distro must block update/repair even when registry latest is not known",
  );
  assert(
    managerFreshnessStatus(managerBehindDistro.managerFreshness).includes("older than local distro"),
    "manager freshness status must explain local distro skew",
  );
  assert(
    managerFreshnessBlockReason(managerBehindDistro.managerFreshness).includes("latest safety gates"),
    "manager freshness block reason must explain why self-update comes first",
  );

  const installedPackageBehind = decisionsFixture({
    packageAudit: {
      packages: [{ packageName: "pi-subagents", status: "installed-behind-baseline" }],
    },
  });
  assert(
    buildPlanDecisions(installedPackageBehind).actions.some((item) => item.id === "managed-npm-packages"),
    "installed managed npm package drift must create a package sync action",
  );

  const baselinePackageBehind = decisionsFixture({
    packageAudit: {
      packages: [{
        packageName: "pi-subagents",
        status: "baseline-behind-latest",
        versionRange: "^0.33.1",
        latestVersion: "0.34.0",
      }],
    },
  });
  assert(
    buildPlanDecisions(baselinePackageBehind).warnings.some((item) => item.includes("pi-subagents latest 0.34.0")),
    "managed npm package baseline drift must be visible as a warning",
  );
}

function runUpdateSafetySelfTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-safety-"));
  const agentDir = path.join(tmpRoot, "agent");
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{\"theme\":\"dark\"}\n");
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{\"apiKey\":\"redacted-test\"}\n");
  const lifecycle = beginUpdateLifecycle({
    agentDir,
    repoRoot: agentDir,
    stateDir,
  }, {
    operation: "test",
    plan: { schema: "pi67.update-plan.v1", actions: [], blocked: [], warnings: [] },
  });
  assert(fs.existsSync(lifecycle.lockPath), "update lifecycle must acquire a lock");
  assert(fs.existsSync(path.join(lifecycle.backupDir, "backup-manifest.json")), "update lifecycle must write backup manifest");
  assert(
    lifecycle.backedUp.some((item) => item.path === "settings.json") &&
      lifecycle.backedUp.some((item) => item.path === "auth.json"),
    "update lifecycle must snapshot preserved runtime files",
  );
  lifecycle.release();
  assert(!fs.existsSync(lifecycle.lockPath), "update lifecycle must release lock");
  const ctx = { agentDir, repoRoot: agentDir, stateDir };
  assert(
    listRuntimeBackups(ctx).some((item) => item.path === lifecycle.backupDir),
    "update lifecycle backups must be listable",
  );
  const backupCountBeforeDedupe = listRuntimeBackups(ctx).length;
  const duplicateLifecycle = beginUpdateLifecycle({
    agentDir,
    repoRoot: agentDir,
    stateDir,
  }, {
    operation: "test",
  });
  assert(duplicateLifecycle.backupSkipped, "unchanged update lifecycle snapshots must be deduplicated");
  duplicateLifecycle.release();
  assert(
    listRuntimeBackups(ctx).length === backupCountBeforeDedupe,
    "deduplicated update lifecycle snapshots must not create new backup directories",
  );
  const backupCountBeforeDelegated = listRuntimeBackups(ctx).length;
  const delegatedLifecycle = beginUpdateLifecycle({
    agentDir,
    repoRoot: agentDir,
    stateDir,
  }, {
    operation: "test-delegated",
    backupRuntime: false,
  });
  assert(fs.existsSync(delegatedLifecycle.lockPath), "delegated update lifecycle must still acquire a lock");
  assert(
    delegatedLifecycle.backupSkipped && !delegatedLifecycle.backupDir && delegatedLifecycle.backedUp.length === 0,
    "delegated update lifecycle must skip manager-owned runtime backups",
  );
  delegatedLifecycle.release();
  assert(!fs.existsSync(delegatedLifecycle.lockPath), "delegated update lifecycle must release lock");
  assert(
    listRuntimeBackups(ctx).length === backupCountBeforeDelegated,
    "delegated update lifecycle must not create runtime backup directories",
  );
  assert(
    inspectRuntimeBackup(ctx, lifecycle.backupDir).fileCount >= 2,
    "update lifecycle backups must be inspectable",
  );
  assert(
    inspectRuntimeBackup(ctx, lifecycle.backupDir).preservedCount >= 6,
    "update lifecycle backups must record missing preserved runtime slots",
  );
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{\"theme\":\"changed\"}\n");
  fs.writeFileSync(path.join(agentDir, "models.json"), "{\"createdAfterBackup\":true}\n");
  const restore = restoreRuntimeBackup(ctx, lifecycle.backupDir);
  assert(
    restore.restored.some((item) => item.path === "settings.json"),
    "runtime backup restore must restore settings.json",
  );
  assert(
    restore.removed.some((item) => item.path === "models.json") &&
      !fs.existsSync(path.join(agentDir, "models.json")),
    "runtime backup restore must remove preserved files that were missing at backup time",
  );
  assert(
    fs.readFileSync(path.join(agentDir, "settings.json"), "utf8").includes("\"dark\""),
    "runtime backup restore must recover the backed up file content",
  );
  const legacyRoot = path.join(path.dirname(stateDir), "agent-backups", "pre-update-20260707-235901");
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "local.diff"), "diff --git a/settings.json b/settings.json\n");
  fs.writeFileSync(path.join(legacyRoot, "settings.json"), "{\"theme\":\"legacy\"}\n");
  assert(
    listLegacyConflictBackups(ctx).some((item) => item.id === "pre-update-20260707-235901" && item.hasLocalDiff),
    "legacy PowerShell conflict backups must be listable",
  );
  assert(
    inspectLegacyConflictBackup(ctx, "pre-update-20260707-235901").files.some((item) => item.name === "local.diff"),
    "legacy PowerShell conflict backups must be inspectable",
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function decisionsFixture(overrides = {}) {
  const base = {
    ctx: { skillsDir: "/tmp/pi67-skills" },
    git: { isRepo: true, dirty: false, short: "" },
    managerRegistry: { outdated: false },
    manifest: {
      runtimeFiles: {
        preserve: ["settings.json", "models.json", "auth.json", "mcp.json", "image-gen.json"],
      },
      localExtensions: [
        { name: "xtalpi-pi-tools", owner: "pi67-managed", exists: true, path: "extensions/xtalpi-pi-tools" },
        { name: "pi-vision-bridge", owner: "pi67-managed", exists: true, path: "extensions/pi-vision-bridge" },
        { name: "pi-rules-loader", owner: "pi67-managed", exists: true, path: "extensions/pi-rules-loader" },
      ],
    },
    skills: { summary: { missing: 0, conflicts: 0 } },
    external: [],
    scriptStatus: {},
    theme: "",
    themeInstalled: false,
    strictSharedSkills: false,
  };
  return deepMerge(base, overrides);
}

function extensionRegistryTestManifest() {
  return {
    theme: {
      policy: "install-theme-package-only-never-select-theme-on-update",
    },
    sharedSkills: {
      policy: "copy-by-default-preserve-different-existing-skills-unless-strict",
    },
    localExtensions: [
      { name: "xtalpi-pi-tools", owner: "pi67-managed" },
      { name: "pi-vision-bridge", owner: "pi67-managed" },
      { name: "pi-rules-loader", owner: "pi67-managed" },
    ],
  };
}

function mutateExtension(registry, id, mutate) {
  const next = clone(registry);
  const entry = next.extensions.find((item) => item.id === id);
  assert(entry, `test registry missing ${id}`);
  mutate(entry);
  return next;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, overrides) {
  const next = clone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && next[key] && typeof next[key] === "object" && !Array.isArray(next[key])) {
      next[key] = deepMerge(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    async json() {
      return payload;
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
