import fs from "node:fs";
import path from "node:path";
import { gitStatus } from "./git.mjs";
import { currentTheme } from "./theme-policy.mjs";
import { readJsonFileIfExists, writeJsonAtomic } from "./config-json.mjs";
import { readCliPackageJson, readTextIfExists } from "./paths.mjs";
import {
  mergeSettingsRuntimeMarkerIntoState,
  settingsRuntimeMarkerFromObject,
  settingsRuntimeMarkerFromState,
} from "./settings-runtime-state.mjs";

export function writeState(ctx, operation) {
  const pkg = readCliPackageJson();
  const git = gitStatus(ctx.repoRoot);
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  const statePath = path.join(ctx.stateDir, "state.json");
  const previous = readJsonFileIfExists(statePath) || {};
  const state = {
    schema: "pi67.state.v1",
    updatedAt: new Date().toISOString(),
    operation,
    managerPackage: pkg.name,
    managerVersion: pkg.version,
    agentDir: ctx.agentDir,
    repoRoot: ctx.repoRoot,
    skillsDir: ctx.skillsDir,
    packagesDir: ctx.packagesDir,
    lastKnownVersion: readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim(),
    lastKnownCommit: git.commit || "",
    lastTheme: currentTheme(ctx),
    lastProvider: settings.defaultProvider || "",
    lastModel: settings.defaultModel || "",
  };
  const mergedState = mergeSettingsRuntimeMarkerIntoState(
    state,
    settingsRuntimeMarkerFromObject(settings) || settingsRuntimeMarkerFromState(previous),
    state.updatedAt,
  );
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  writeJsonAtomic(statePath, mergedState);
  return mergedState;
}
