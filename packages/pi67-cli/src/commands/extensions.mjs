import { parseCommandOptions } from "../lib/args.mjs";
import { buildDistroManifest } from "../lib/distro-manifest.mjs";
import { REQUIRED_EXTENSION_REGISTRY_IDS, validateExtensionRegistry } from "../lib/extension-registry.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { CliError, fail, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function extensionsCommand(ctx, argv) {
  const [sub = "list", ...rest] = argv;
  if (sub === "list") return list(ctx, rest);
  if (sub === "doctor") return doctor(ctx, rest);
  if (sub === "inspect") return inspect(ctx, rest);
  if (sub === "plan") return plan(ctx, rest);
  if (sub === "update") return updateHint(ctx, rest);
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printExtensionsHelp();
    return;
  }
  throw new CliError(`unknown extensions command: ${sub}`, 2);
}

function list(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  const manifest = buildDistroManifest(ctx);
  const data = {
    schema: "pi67.extensions-list.v1",
    createdAt: new Date().toISOString(),
    extensions: manifest.extensionRegistry.extensions,
    localExtensions: manifest.localExtensions,
    summary: manifest.summary,
  };
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 extension registry");
  keyValue("Registered", data.extensions.length);
  keyValue("Local", `${manifest.summary.localExtensions - manifest.summary.missingLocalExtensions}/${manifest.summary.localExtensions} present`);
  for (const item of data.extensions) {
    info(`${item.id}: ${item.kind}; owner=${item.owner}; update=${item.updateStrategy}`);
  }
}

function doctor(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "strict-shared-skills", "no-remote"],
  });
  const manifest = buildDistroManifest(ctx);
  const validation = validateExtensionRegistry(manifest.extensionRegistry, {
    manifest,
    requiredIds: REQUIRED_EXTENSION_REGISTRY_IDS,
  });
  const updatePlan = buildUpdatePlan(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
    strictSharedSkills: options.strictSharedSkills,
  });
  const data = {
    schema: "pi67.extensions-doctor.v1",
    createdAt: new Date().toISOString(),
    validation,
    localExtensions: manifest.localExtensions,
    policy: {
      theme: manifest.theme.policy,
      sharedSkills: manifest.sharedSkills.policy,
      externalRepos: manifest.externalReposPolicy,
    },
    updatePlan: {
      actions: updatePlan.actions.filter((item) => extensionActionKinds().has(item.kind)),
      blocked: updatePlan.blocked.filter((item) => extensionBlockKinds().has(item.kind)),
      warnings: updatePlan.warnings,
    },
  };
  if (ctx.json || options.json) {
    printJson(data);
    if (!validation.ok) process.exitCode = 1;
    return;
  }
  section("pi-67 extensions doctor");
  if (validation.ok) pass(validation.message);
  else {
    for (const problem of validation.problems) fail(problem);
    process.exitCode = 1;
  }
  for (const warning of validation.warnings) warn(warning);
  section("Local extensions");
  for (const item of manifest.localExtensions) {
    if (item.exists) pass(`${item.name}: ${item.path} (${item.owner})`);
    else warn(`${item.name}: missing ${item.path}`);
  }
  section("Extension-related update plan");
  for (const action of data.updatePlan.actions) {
    info(`${action.id}: ${action.operation}; preserves=${action.preserves.join(", ")}`);
  }
  for (const blocked of data.updatePlan.blocked) {
    warn(`${blocked.id}: ${blocked.reason}`);
  }
}

function inspect(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  const id = positionals[0];
  if (!id) throw new CliError("extensions inspect requires an extension id", 2);
  const manifest = buildDistroManifest(ctx);
  const entry = manifest.extensionRegistry.extensions.find((item) => item.id === id);
  if (!entry) throw new CliError(`unknown registered extension: ${id}`, 2);
  const local = manifest.localExtensions.find((item) => item.name === id) || null;
  const data = {
    schema: "pi67.extensions-inspect.v1",
    createdAt: new Date().toISOString(),
    extension: entry,
    local,
  };
  if (ctx.json || options.json) return printJson(data);
  section(`pi-67 extension: ${id}`);
  keyValue("Kind", entry.kind);
  keyValue("Owner", entry.owner);
  keyValue("Install", entry.installStrategy);
  keyValue("Update", entry.updateStrategy);
  keyValue("Repair", entry.repairStrategy);
  if (entry.path) keyValue("Path", entry.path);
  if (entry.target) keyValue("Target", entry.target);
  if (local) keyValue("Local exists", local.exists ? "yes" : "no");
  section("Smoke gates");
  for (const smoke of entry.smoke) info(smoke);
}

function plan(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "strict-shared-skills", "no-remote"],
  });
  const updatePlan = buildUpdatePlan(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
    strictSharedSkills: options.strictSharedSkills,
  });
  const data = {
    schema: "pi67.extensions-plan.v1",
    createdAt: new Date().toISOString(),
    actions: updatePlan.actions.filter((item) => extensionActionKinds().has(item.kind)),
    blocked: updatePlan.blocked.filter((item) => extensionBlockKinds().has(item.kind)),
    warnings: updatePlan.warnings,
  };
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 extension update plan");
  for (const action of data.actions) info(`${action.id}: ${action.operation}`);
  for (const blocked of data.blocked) warn(`${blocked.id}: ${blocked.reason}`);
  for (const warning of data.warnings) warn(warning);
  if (data.actions.length === 0 && data.blocked.length === 0) pass("no extension-related action is required");
}

function updateHint(_ctx, argv) {
  const { positionals } = parseCommandOptions(argv, { bools: ["dry-run"] });
  const id = positionals[0] || "<id>";
  throw new CliError(
    [
      "pi-67 extensions update is intentionally not a generic overwrite entrypoint.",
      `For first-party bundled extensions, run: pi-67 update --repair`,
      `For external repos, run: pi-67 external update ${id}`,
      "For shared skills, run: pi-67 skills sync",
      "For themes, run: pi-67 themes list/current/set explicitly.",
    ].join("\n"),
    2,
  );
}

function extensionActionKinds() {
  return new Set(["local-extension", "theme-package", "skill-pack"]);
}

function extensionBlockKinds() {
  return new Set(["external-repo", "skill-pack"]);
}

function printExtensionsHelp() {
  process.stdout.write(`pi-67 extensions - inspect pi-67 extension ownership policy

Usage:
  pi-67 extensions list [--json]
  pi-67 extensions doctor [--json] [--strict-shared-skills]
  pi-67 extensions inspect <id> [--json]
  pi-67 extensions plan [--json] [--strict-shared-skills]

Notes:
  Generic extension overwrite updates are intentionally not supported.
  Use pi-67 update --repair for first-party bundled extensions, pi-67 external
  update <name> for external repos, pi-67 skills sync for shared skills, and
  pi-67 themes set <name> for explicit theme selection changes.
`);
}
