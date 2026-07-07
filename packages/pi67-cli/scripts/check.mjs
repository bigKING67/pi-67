import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmPublishTargetStatus } from "../src/lib/npm-registry.mjs";
import { readExtensionRegistry, validateExtensionRegistry } from "../src/lib/extension-registry.mjs";

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
runPublishTargetSelfTests();
runExtensionRegistrySelfTests();

function walk(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
