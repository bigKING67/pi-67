import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "./paths.mjs";

export const REQUIRED_EXTENSION_REGISTRY_IDS = [
  "xtalpi-pi-tools",
  "pi-vision-bridge",
  "pi-rules-loader",
  "pi-curated-themes",
  "shared-skills",
  "browser67",
  "design-craft",
];

const REQUIRED_TOP_LEVEL = ["schema", "governance", "extensions"];
const REQUIRED_ENTRY_FIELDS = [
  "id",
  "kind",
  "owner",
  "installStrategy",
  "updateStrategy",
  "repairStrategy",
  "configPatches",
  "smoke",
];
const REQUIRED_PATCH_FIELDS = ["file", "path", "mode"];
const STRATEGY_FIELDS = ["installStrategy", "updateStrategy", "repairStrategy"];

export function readExtensionRegistry(file = defaultExtensionRegistryFile()) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function defaultExtensionRegistryFile() {
  return path.join(packageRoot(), "src", "data", "extension-registry.json");
}

export function validateExtensionRegistry(registry, options = {}) {
  const manifest = options.manifest || {};
  const requiredIds = options.requiredIds || REQUIRED_EXTENSION_REGISTRY_IDS;
  const problems = [];
  const warnings = [];

  if (!isPlainObject(registry)) {
    return {
      ok: false,
      message: "extension registry must be an object",
      problems: ["extension registry must be an object"],
      warnings,
      summary: emptySummary(),
    };
  }

  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in registry)) problems.push(`extension registry missing ${field}`);
  }
  if (registry.schema !== "pi67.extension-registry.v1") {
    problems.push(`extension registry schema must be pi67.extension-registry.v1, got ${registry.schema || "missing"}`);
  }

  const governance = isPlainObject(registry.governance) ? registry.governance : {};
  if (!isPlainObject(registry.governance)) {
    problems.push("extension registry governance must be an object");
  }
  const allowedPatchModes = new Set(arrayOfStrings(governance.configPatchModes));
  const forbiddenFragments = arrayOfStrings(governance.forbiddenUpdateBehavior);
  if (allowedPatchModes.size === 0) {
    problems.push("extension registry governance must declare configPatchModes");
  }
  if (forbiddenFragments.length === 0) {
    problems.push("extension registry governance must declare forbiddenUpdateBehavior");
  }

  const entries = Array.isArray(registry.extensions) ? registry.extensions : [];
  if (!Array.isArray(registry.extensions)) {
    problems.push("extension registry extensions must be an array");
  }

  const ids = new Set();
  const duplicateIds = [];
  for (const [index, entry] of entries.entries()) {
    const label = entryLabel(entry, index);
    if (!isPlainObject(entry)) {
      problems.push(`${label} must be an object`);
      continue;
    }
    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!(field in entry)) problems.push(`${label} missing ${field}`);
    }
    if (typeof entry.id === "string" && entry.id.length > 0) {
      if (ids.has(entry.id)) duplicateIds.push(entry.id);
      ids.add(entry.id);
    } else {
      problems.push(`${label} id must be a non-empty string`);
    }
    for (const field of STRATEGY_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        problems.push(`${label} ${field} must be a non-empty string`);
      }
    }
    if (!Array.isArray(entry.configPatches)) {
      problems.push(`${label} configPatches must be an array`);
    } else {
      validateConfigPatches(entry, label, allowedPatchModes, problems);
    }
    if (!Array.isArray(entry.smoke) || entry.smoke.length === 0) {
      problems.push(`${label} must declare at least one smoke gate`);
    } else if (entry.smoke.some((item) => typeof item !== "string" || item.length === 0)) {
      problems.push(`${label} smoke gates must be non-empty strings`);
    }
    validateForbiddenStrategyText(entry, label, forbiddenFragments, problems);
  }

  for (const id of duplicateIds) {
    problems.push(`duplicate extension registry id: ${id}`);
  }
  for (const id of requiredIds) {
    if (!ids.has(id)) problems.push(`missing extension registry entry: ${id}`);
  }

  validateManifestParity(entries, manifest, problems, warnings);

  const summary = {
    entries: entries.length,
    requiredEntries: requiredIds.length,
    duplicateIds: duplicateIds.length,
    smokeGates: entries.reduce((count, entry) => count + (Array.isArray(entry?.smoke) ? entry.smoke.length : 0), 0),
    configPatches: entries.reduce((count, entry) => count + (Array.isArray(entry?.configPatches) ? entry.configPatches.length : 0), 0),
  };

  return {
    ok: problems.length === 0,
    message: problems.length === 0 ? "extension registry policy ready" : problems.join("; "),
    problems,
    warnings,
    summary,
  };
}

function validateConfigPatches(entry, label, allowedPatchModes, problems) {
  for (const [index, patch] of entry.configPatches.entries()) {
    const patchLabel = `${label} configPatches[${index}]`;
    if (!isPlainObject(patch)) {
      problems.push(`${patchLabel} must be an object`);
      continue;
    }
    for (const field of REQUIRED_PATCH_FIELDS) {
      if (!(field in patch)) problems.push(`${patchLabel} missing ${field}`);
    }
    if (!allowedPatchModes.has(patch.mode)) {
      problems.push(`${label} has unsupported config patch mode: ${patch.mode || "missing"}`);
    }
    if (!isSafePatchMode(patch)) {
      problems.push(`${label} config patch for ${patch.file || "unknown"} must preserve user config or be template/theme report-only`);
    }
  }
}

function isSafePatchMode(patch) {
  if (patch.mode === "merge-preserve") return true;
  if (patch.mode === "template-only" && String(patch.file || "").endsWith(".example.json")) return true;
  if (patch.mode === "report-only" && isThemeSelectionReportOnlyPatch(patch)) return true;
  return false;
}

function isThemeSelectionReportOnlyPatch(patch) {
  if (patch.file === "settings.json" && patch.path === "theme") return true;
  if (patch.file === "settings.json.theme") return true;
  return false;
}

function validateForbiddenStrategyText(entry, label, forbiddenFragments, problems) {
  const policyText = [
    entry.installStrategy,
    entry.updateStrategy,
    entry.repairStrategy,
    ...(Array.isArray(entry.explicitCommands) ? entry.explicitCommands : []),
  ].join(" ");
  for (const fragment of forbiddenFragments) {
    if (policyText.includes(fragment)) {
      problems.push(`${label} uses forbidden behavior: ${fragment}`);
    }
  }
}

function validateManifestParity(entries, manifest, problems, warnings) {
  const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));

  const managedLocalExtensions = Array.isArray(manifest.localExtensions)
    ? manifest.localExtensions.filter((item) => item.owner === "pi67-managed")
    : [];
  for (const item of managedLocalExtensions) {
    if (!byId.has(item.name)) {
      problems.push(`managed local extension missing registry entry: ${item.name}`);
    }
  }

  const theme = byId.get("pi-curated-themes");
  if (theme) {
    if (manifest.theme?.policy && theme.updateStrategy !== manifest.theme.policy) {
      problems.push("theme extension registry policy must match manifest theme policy");
    }
    if (theme.configPatches?.some((patch) => patch.mode !== "report-only" || !isThemeSelectionReportOnlyPatch(patch))) {
      problems.push("theme extension registry must only report current theme selection during update");
    }
  }

  const sharedSkills = byId.get("shared-skills");
  if (sharedSkills && manifest.sharedSkills?.policy && sharedSkills.updateStrategy !== manifest.sharedSkills.policy) {
    problems.push("shared-skills extension registry policy must match manifest shared skills policy");
  }

  for (const entry of entries.filter((item) => item?.kind === "external-repo")) {
    if (entry.updateStrategy !== "preserve-and-block-update-when-dirty") {
      problems.push(`external repo ${entry.id} must block dirty updates`);
    }
    if (!entry.explicitCommands?.some((command) => command.includes("external update"))) {
      warnings.push(`external repo ${entry.id} has no explicit external update command documented`);
    }
  }

  const xtalpi = byId.get("xtalpi-pi-tools");
  if (xtalpi) {
    if (xtalpi.kind !== "local-provider") problems.push("xtalpi-pi-tools must remain a local-provider registry entry");
    if (xtalpi.path !== "extensions/xtalpi-pi-tools") problems.push("xtalpi-pi-tools path must remain extensions/xtalpi-pi-tools");
    if (xtalpi.repairStrategy !== "local-json-action-protocol-repair") {
      problems.push("xtalpi-pi-tools must use local JSON action protocol repair");
    }
  }
}

function entryLabel(entry, index) {
  return `extension ${entry?.id || `#${index}`}`;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptySummary() {
  return {
    entries: 0,
    requiredEntries: 0,
    duplicateIds: 0,
    smokeGates: 0,
    configPatches: 0,
  };
}
