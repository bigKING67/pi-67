import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  migrateSettingsRuntimeState,
  mergeSettingsRuntimeMarkerIntoState,
  refreshSettingsGitIndex,
  settingsRuntimeMarkerFromObject,
  stripSettingsRuntimeMarkerText,
} from "../../src/lib/settings-runtime-state.mjs";

export function runSettingsRuntimeStateSelfTests() {
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
    runTrackedSettingsCompatibilityTest();
    runIgnoredSettingsOwnershipTest();
  }
}

function runTrackedSettingsCompatibilityTest() {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-settings-index-refresh-"));
  const gitStateDir = path.join(gitRoot, "state");
  try {
    fs.writeFileSync(path.join(gitRoot, ".gitattributes"), "settings.json text eol=lf\n");
    fs.writeFileSync(path.join(gitRoot, "settings.json"), "{\n  \"theme\": \"gruvbox-dark\"\n}\n");
    initializeGitFixture(gitRoot, [".gitattributes", "settings.json"]);
    fs.writeFileSync(path.join(gitRoot, "settings.json"), "{\r\n  \"theme\": \"gruvbox-dark\"\r\n}\r\n");
    const statusBefore = spawnSync("git", ["-C", gitRoot, "status", "--short", "--", "settings.json"], { encoding: "utf8" });
    const diffBefore = spawnSync("git", ["-C", gitRoot, "diff", "--quiet", "--", "settings.json"], { encoding: "utf8" });
    assert(statusBefore.stdout.includes("settings.json"), "settings index refresh self-test must start with false-dirty status");
    assert(diffBefore.status === 0, "settings index refresh self-test must have no real content diff");
    const refreshResult = refreshSettingsGitIndex({ agentDir: gitRoot, repoRoot: gitRoot, stateDir: gitStateDir });
    const statusAfter = spawnSync("git", ["-C", gitRoot, "status", "--short", "--", "settings.json"], { encoding: "utf8" });
    assert(refreshResult.refreshed === true, "settings index refresh must classify cleared false-dirty status");
    assert(!statusAfter.stdout.trim(), `settings index refresh must clear false-dirty status\n${statusAfter.stdout}`);
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
}

function runIgnoredSettingsOwnershipTest() {
  const untrackedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-settings-untracked-"));
  const untrackedStateDir = path.join(untrackedRoot, "state");
  const templateText = "{\n  \"theme\": \"gruvbox-dark\",\n  \"defaultProvider\": \"xtalpi-pi-tools\"\n}\n";
  try {
    fs.writeFileSync(path.join(untrackedRoot, ".gitignore"), "settings.json\n");
    fs.writeFileSync(path.join(untrackedRoot, "settings.example.json"), templateText);
    initializeGitFixture(untrackedRoot, [".gitignore", "settings.example.json"], [
      ["config", "filter.pi67-settings-runtime-state.clean", "node legacy-filter.mjs --clean"],
      ["config", "filter.pi67-settings-runtime-state.required", "false"],
    ]);
    const untrackedResult = migrateSettingsRuntimeState(
      { agentDir: untrackedRoot, repoRoot: untrackedRoot, stateDir: untrackedStateDir },
      { normalizeSettingsJson: true, installGitFilter: true },
    );
    assert(untrackedResult.settingsCreatedFromTemplate === true, "missing ignored settings.json must be created from template");
    assert(untrackedResult.gitFilterRemoved === true, "untracked settings migration must remove the legacy Git filter");
    assert(fs.readFileSync(path.join(untrackedRoot, "settings.json"), "utf8") === templateText, "settings template bytes must be preserved");
    const ignored = spawnSync("git", ["-C", untrackedRoot, "check-ignore", "-q", "settings.json"]);
    assert(ignored.status === 0, "generated settings.json must be ignored");
    const untrackedStatus = spawnSync("git", ["-C", untrackedRoot, "status", "--short"], { encoding: "utf8" });
    assert(!untrackedStatus.stdout.trim(), `generated settings.json must keep the repo clean\n${untrackedStatus.stdout}`);
    const legacyFilter = spawnSync("git", [
      "-C", untrackedRoot, "config", "--local", "--get-regexp", "^filter\\.pi67-settings-runtime-state\\.",
    ], { encoding: "utf8" });
    assert(legacyFilter.status !== 0, "legacy settings Git filter config must be removed");
  } finally {
    fs.rmSync(untrackedRoot, { recursive: true, force: true });
  }
}

function initializeGitFixture(root, trackedFiles, beforeCommit = []) {
  const commands = [
    ["init", "-q"],
    ["config", "user.email", "pi67-check@example.invalid"],
    ["config", "user.name", "pi67-check"],
    ...beforeCommit,
    ["add", ...trackedFiles],
    ["commit", "-q", "-m", "init"],
  ];
  for (const args of commands) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert(result.status === 0, `git setup failed for settings self-test: git ${args.join(" ")}\n${result.stderr}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
