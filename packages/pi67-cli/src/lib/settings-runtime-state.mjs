import fs from "node:fs";
import path from "node:path";
import { captureCommand } from "./shell-runner.mjs";
import { isGitRepo } from "./git.mjs";
import { readJsonFileIfExists, writeJsonAtomic } from "./config-json.mjs";
import {
  SETTINGS_RUNTIME_MARKER_KEY,
  stableSettingsJson,
  stripSettingsRuntimeMarker,
  stripSettingsRuntimeMarkerText,
} from "./settings-runtime-clean.mjs";

export const SETTINGS_RUNTIME_FILTER_NAME = "pi67-settings-runtime-state";
export const SETTINGS_RUNTIME_FILTER_SCRIPT = "packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs";
export const SETTINGS_TEMPLATE_FILE = "settings.example.json";

export { SETTINGS_RUNTIME_MARKER_KEY, stripSettingsRuntimeMarker, stripSettingsRuntimeMarkerText };

export function settingsRuntimeMarkerFromObject(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const value = settings[SETTINGS_RUNTIME_MARKER_KEY];
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return {
    key: SETTINGS_RUNTIME_MARKER_KEY,
    value: String(value),
  };
}

export function settingsRuntimeMarkerFromState(state) {
  const marker = state?.runtimeMarkers?.[SETTINGS_RUNTIME_MARKER_KEY];
  if (!marker || marker.value === undefined || marker.value === null || String(marker.value).trim() === "") {
    return null;
  }
  return {
    key: SETTINGS_RUNTIME_MARKER_KEY,
    value: String(marker.value),
  };
}

export function mergeSettingsRuntimeMarkerIntoState(state, marker, now = new Date().toISOString()) {
  const next = { ...(state || {}) };
  const runtimeMarkers = { ...(next.runtimeMarkers || {}) };
  if (marker?.value) {
    runtimeMarkers[SETTINGS_RUNTIME_MARKER_KEY] = {
      value: marker.value,
      source: "settings.json",
      storage: "state.json",
      updatedAt: now,
    };
  }
  if (Object.keys(runtimeMarkers).length > 0) {
    next.runtimeMarkers = runtimeMarkers;
  }
  return next;
}

export function migrateSettingsRuntimeState(ctx, options = {}) {
  const normalizeSettingsJson = Boolean(options.normalizeSettingsJson);
  const installGitFilter = Boolean(options.installGitFilter);
  const dryRun = Boolean(options.dryRun);
  const settingsPath = path.join(ctx.agentDir, "settings.json");
  const templatePath = path.join(ctx.repoRoot, SETTINGS_TEMPLATE_FILE);
  const statePath = path.join(ctx.stateDir, "state.json");
  const result = {
    schema: "pi67.settings-runtime-state.v1",
    settingsPath,
    templatePath,
    statePath,
    settingsCreatedFromTemplate: false,
    markerFound: false,
    markerValue: "",
    stateWritten: false,
    settingsNormalized: false,
    settingsNormalizeReasons: [],
    gitIndexRefreshed: false,
    gitIndexRefreshSkipped: "",
    gitFilterInstalled: false,
    gitFilterRemoved: false,
    skipped: [],
    errors: [],
  };

  if (!fs.existsSync(settingsPath) && fs.existsSync(templatePath)) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.copyFileSync(templatePath, settingsPath);
      try {
        fs.chmodSync(settingsPath, 0o600);
      } catch {
        // Windows and restricted filesystems may not support POSIX modes.
      }
    }
    result.settingsCreatedFromTemplate = true;
  }

  if (!fs.existsSync(settingsPath)) {
    result.skipped.push(result.settingsCreatedFromTemplate
      ? "settings.json would be created from template"
      : `${SETTINGS_TEMPLATE_FILE} missing; settings.json was not created`);
  } else {
    let rawSettingsText = "";
    let settingsText = "";
    let settings = null;
    try {
      rawSettingsText = fs.readFileSync(settingsPath, "utf8");
      settingsText = rawSettingsText.replace(/^\uFEFF/, "");
      settings = JSON.parse(settingsText);
    } catch (error) {
      result.errors.push(`settings.json is not valid JSON: ${error.message}`);
    }

    const marker = settingsRuntimeMarkerFromObject(settings);
    if (marker) {
      result.markerFound = true;
      result.markerValue = marker.value;
      if (!dryRun) {
        const previous = readJsonFileIfExists(statePath) || {};
        writeJsonAtomic(statePath, mergeSettingsRuntimeMarkerIntoState(previous, marker));
        result.stateWritten = true;
      }
      if (normalizeSettingsJson) {
        const normalizedText = stableSettingsJson(stripSettingsRuntimeMarker(settings));
        if (normalizedText !== rawSettingsText) {
          if (!dryRun) {
            fs.writeFileSync(settingsPath, normalizedText, "utf8");
          }
          result.settingsNormalized = true;
          result.settingsNormalizeReasons.push("runtime-marker");
          if (normalizeSettingsTextLineEndings(rawSettingsText) !== rawSettingsText) {
            result.settingsNormalizeReasons.push("line-endings");
          }
        }
      }
    } else {
      if (normalizeSettingsJson && settings) {
        const normalizedText = normalizeSettingsTextLineEndings(rawSettingsText);
        if (normalizedText !== rawSettingsText) {
          if (!dryRun) {
            fs.writeFileSync(settingsPath, normalizedText, "utf8");
          }
          result.settingsNormalized = true;
          result.settingsNormalizeReasons.push("line-endings");
        }
      }
      result.skipped.push("settings.json runtime marker absent");
    }
  }

  if (installGitFilter) {
    const filterResult = installSettingsRuntimeGitFilter(ctx, { dryRun });
    result.gitFilterInstalled = filterResult.installed;
    result.gitFilterRemoved = filterResult.removed;
    if (filterResult.skipped) result.skipped.push(filterResult.skipped);
    if (filterResult.error) result.errors.push(filterResult.error);
  }

  if (normalizeSettingsJson) {
    const refreshResult = refreshSettingsGitIndex(ctx, { dryRun });
    result.gitIndexRefreshed = refreshResult.refreshed;
    result.gitIndexRefreshSkipped = refreshResult.skipped;
    if (refreshResult.error) result.errors.push(refreshResult.error);
  }

  return result;
}

export function normalizeSettingsTextLineEndings(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

export function refreshSettingsGitIndex(ctx, options = {}) {
  const result = {
    refreshed: false,
    skipped: "",
    error: "",
  };
  if (options.dryRun) {
    result.refreshed = true;
    return result;
  }
  if (!isGitRepo(ctx.repoRoot)) {
    result.skipped = "repo root is not a git checkout";
    return result;
  }
  if (!settingsTrackedByGit(ctx)) {
    result.skipped = "settings.json is untracked runtime state; Git index refresh is not needed";
    return result;
  }

  const settingsPath = path.join(ctx.agentDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    result.skipped = "settings.json missing";
    return result;
  }

  const relativePath = path.relative(ctx.repoRoot, settingsPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    result.skipped = "settings.json is outside repo root";
    return result;
  }
  const gitPath = relativePath.split(path.sep).join("/");

  const statusBefore = captureCommand("git", ["-C", ctx.repoRoot, "status", "--short", "--", gitPath]);
  if (!statusBefore.ok) {
    result.skipped = "could not inspect settings.json git status before index refresh";
    return result;
  }
  if (!statusBefore.stdout.trim()) {
    result.skipped = "settings.json git index already fresh";
    return result;
  }

  const diffBefore = captureCommand("git", ["-C", ctx.repoRoot, "diff", "--quiet", "--", gitPath]);
  if (diffBefore.status !== 0) {
    result.skipped = "settings.json has real content diff; index refresh left it visible";
    return result;
  }

  const refresh = captureCommand("git", ["-C", ctx.repoRoot, "update-index", "--refresh", "--", gitPath]);

  const statusAfter = captureCommand("git", ["-C", ctx.repoRoot, "status", "--short", "--", gitPath]);
  if (statusAfter.ok && !statusAfter.stdout.trim()) {
    result.refreshed = true;
  } else if (!refresh.ok) {
    result.error = refresh.stderr || refresh.error || "failed to refresh settings.json git index";
  } else {
    result.skipped = "settings.json still appears dirty after git index refresh";
  }
  return result;
}

export function installSettingsRuntimeGitFilter(ctx, options = {}) {
  const result = {
    installed: false,
    removed: false,
    skipped: "",
    error: "",
  };
  if (options.dryRun) {
    result.installed = true;
    return result;
  }
  if (!isGitRepo(ctx.repoRoot)) {
    result.skipped = "repo root is not a git checkout";
    return result;
  }
  if (!settingsTrackedByGit(ctx)) {
    return removeSettingsRuntimeGitFilter(ctx, { dryRun: options.dryRun });
  }
  const scriptPath = path.join(ctx.repoRoot, SETTINGS_RUNTIME_FILTER_SCRIPT);
  if (!fs.existsSync(scriptPath)) {
    result.skipped = `settings runtime filter script missing: ${SETTINGS_RUNTIME_FILTER_SCRIPT}`;
    return result;
  }

  const cleanCommand = `node ${SETTINGS_RUNTIME_FILTER_SCRIPT} --clean`;
  const existingClean = captureCommand("git", [
    "-C",
    ctx.repoRoot,
    "config",
    "--local",
    "--get",
    `filter.${SETTINGS_RUNTIME_FILTER_NAME}.clean`,
  ]);
  const existingRequired = captureCommand("git", [
    "-C",
    ctx.repoRoot,
    "config",
    "--local",
    "--get",
    `filter.${SETTINGS_RUNTIME_FILTER_NAME}.required`,
  ]);
  if (
    existingClean.ok &&
    existingClean.stdout.trim() === cleanCommand &&
    existingRequired.ok &&
    existingRequired.stdout.trim() === "false"
  ) {
    result.skipped = "settings runtime filter already installed";
    return result;
  }

  const clean = captureCommand("git", [
    "-C",
    ctx.repoRoot,
    "config",
    "--local",
    `filter.${SETTINGS_RUNTIME_FILTER_NAME}.clean`,
    cleanCommand,
  ]);
  if (!clean.ok) {
    result.error = clean.stderr || clean.error || "failed to configure settings runtime clean filter";
    return result;
  }
  const required = captureCommand("git", [
    "-C",
    ctx.repoRoot,
    "config",
    "--local",
    `filter.${SETTINGS_RUNTIME_FILTER_NAME}.required`,
    "false",
  ]);
  if (!required.ok) {
    result.error = required.stderr || required.error || "failed to configure settings runtime filter required=false";
    return result;
  }
  result.installed = true;
  return result;
}

export function removeSettingsRuntimeGitFilter(ctx, options = {}) {
  const result = {
    installed: false,
    removed: false,
    skipped: "",
    error: "",
  };
  if (!isGitRepo(ctx.repoRoot)) {
    result.skipped = "repo root is not a git checkout";
    return result;
  }

  const keys = [
    `filter.${SETTINGS_RUNTIME_FILTER_NAME}.clean`,
    `filter.${SETTINGS_RUNTIME_FILTER_NAME}.required`,
  ];
  const configured = keys.some((key) =>
    captureCommand("git", ["-C", ctx.repoRoot, "config", "--local", "--get", key]).ok);
  if (!configured) {
    result.skipped = "settings.json is ignored runtime state; legacy git filter is not configured";
    return result;
  }
  if (options.dryRun) {
    result.removed = true;
    return result;
  }

  for (const key of keys) {
    const unset = captureCommand("git", ["-C", ctx.repoRoot, "config", "--local", "--unset-all", key]);
    if (!unset.ok && unset.status !== 5) {
      result.error = unset.stderr || unset.error || `failed to remove ${key}`;
      return result;
    }
  }
  result.removed = true;
  return result;
}

export function settingsTrackedByGit(ctx) {
  if (!isGitRepo(ctx.repoRoot)) return false;
  const settingsPath = path.join(ctx.agentDir, "settings.json");
  const relativePath = path.relative(ctx.repoRoot, settingsPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;
  const gitPath = relativePath.split(path.sep).join("/");
  return captureCommand("git", [
    "-C",
    ctx.repoRoot,
    "ls-files",
    "--error-unmatch",
    "--",
    gitPath,
  ]).ok;
}
