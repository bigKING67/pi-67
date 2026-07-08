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
  const statePath = path.join(ctx.stateDir, "state.json");
  const result = {
    schema: "pi67.settings-runtime-state.v1",
    settingsPath,
    statePath,
    markerFound: false,
    markerValue: "",
    stateWritten: false,
    settingsNormalized: false,
    settingsNormalizeReasons: [],
    gitFilterInstalled: false,
    skipped: [],
    errors: [],
  };

  if (!fs.existsSync(settingsPath)) {
    result.skipped.push("settings.json missing");
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
    if (filterResult.skipped) result.skipped.push(filterResult.skipped);
    if (filterResult.error) result.errors.push(filterResult.error);
  }

  return result;
}

export function normalizeSettingsTextLineEndings(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

export function installSettingsRuntimeGitFilter(ctx, options = {}) {
  const result = {
    installed: false,
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
