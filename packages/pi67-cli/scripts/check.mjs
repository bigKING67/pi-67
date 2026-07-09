import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmLatestVersion, npmPublishTargetStatus, npmRegistryPackageUrl } from "../src/lib/npm-registry.mjs";
import { commandCandidatesForPlatform, envWithWindowsGitFallback, findWindowsGitExecutable } from "../src/lib/shell-runner.mjs";
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
runArgsSelfTests();
runCliHelpContractSelfTests();
runInstallNonGitAgentDirSelfTests();
runVersionRecommendationSelfTests();
runPublishTargetSelfTests();
runShellRunnerSelfTests();
runExtensionRegistrySelfTests();
runSettingsRuntimeStateSelfTests();
runUpdatePreflightMigrationSelfTests();
runUpdatePlanSelfTests();
runUpdateSafetySelfTests();

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
    parseCommandOptions(["--no-skill-list"], { bools: ["no-skill-list"] }).options.noSkillList,
    "command option parser must accept doctor --no-skill-list",
  );
  assert(
    parseCommandOptions(["--json"], { bools: ["json"] }).options.json,
    "command option parser must accept command-level --json",
  );
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
  }
  assert(
    !fs.existsSync(backupRoot) || fs.readdirSync(backupRoot).length === 0,
    "help commands must not create runtime backups",
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
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
    assert(
      JSON.stringify(commandCandidatesForPlatform("npm", "darwin")) === JSON.stringify(["npm"]),
      "POSIX npm execution should keep the requested command",
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
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
    managerRegistry: { outdated: true },
  });
  assert(
    buildPlanDecisions(managerOutdated).actions.some((item) => item.id === "pi67-manager"),
    "outdated npm manager must produce an explicit self-update action",
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
