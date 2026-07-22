import { parseCommandOptions } from "../lib/args.mjs";
import { buildDistroManifest } from "../lib/distro-manifest.mjs";
import { REQUIRED_EXTENSION_REGISTRY_IDS, validateExtensionRegistry } from "../lib/extension-registry.mjs";
import {
  diffManagedExtension,
  inspectManagedExtensions,
  probePiExtensionLoads,
  restoreManagedExtension,
} from "../lib/managed-extensions.mjs";
import { resolveDistroSourceRoot } from "../lib/release-store.mjs";
import { buildUpdatePlan } from "../lib/update-plan.mjs";
import { CliError, fail, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function extensionsCommand(ctx, argv) {
  const [sub = "list", ...rest] = argv;
  if (sub === "list") return list(ctx, rest);
  if (sub === "doctor") return doctor(ctx, rest);
  if (sub === "inspect") return inspect(ctx, rest);
  if (sub === "plan") return plan(ctx, rest);
  if (sub === "status") return status(ctx, rest);
  if (sub === "diff") return diff(ctx, rest);
  if (sub === "restore") return restore(ctx, rest);
  if (sub === "update") return updateHint(ctx, rest);
  if (["-h", "--help", "help"].includes(sub)) return printExtensionsHelp();
  throw new CliError(`unknown extensions command: ${sub}`, 2);
}
function list(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printExtensionsHelp();
  const manifest = buildDistroManifest(ctx);
  const managed = inspectManagedExtensions(ctx, { sourceRoot: resolveDistroSourceRoot(ctx) });
  const data = {
    schema: "pi67.extensions-list.v2",
    createdAt: new Date().toISOString(),
    governanceExtensions: manifest.extensionRegistry.extensions,
    localExtensions: manifest.localExtensions,
    managedExtensions: managed.extensions,
    managedSummary: managed.summary,
  };
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 default extension baselines");
  keyValue("Default extensions", data.managedExtensions.length);
  keyValue("Governance entries", data.governanceExtensions.length);
  for (const item of data.managedExtensions) {
    info(`${item.id}: ${item.status}; action=${item.action}; baseline=${item.minimumVersion || item.minimumCommit}`);
  }
}

async function doctor(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "strict-shared-skills", "no-remote", "deep"],
  });
  if (options.help) return printExtensionsHelp();
  const sourceRoot = resolveDistroSourceRoot(ctx);
  const manifest = buildDistroManifest(ctx);
  const validation = validateExtensionRegistry(manifest.extensionRegistry, {
    manifest,
    requiredIds: REQUIRED_EXTENSION_REGISTRY_IDS,
  });
  const loadProbe = options.deep ? probePiExtensionLoads(ctx) : null;
  const managed = inspectManagedExtensions(ctx, { sourceRoot, deepHash: true, loadProbe });
  const updatePlan = await buildUpdatePlan(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
    strictSharedSkills: options.strictSharedSkills,
    sourceRoot,
  });
  const data = {
    schema: "pi67.extensions-doctor.v2",
    createdAt: new Date().toISOString(),
    validation,
    localExtensions: manifest.localExtensions,
    managedExtensions: managed,
    policy: managed.policy,
    updatePlan: {
      actions: updatePlan.actions.filter((item) => extensionActionKinds().has(item.kind)),
      blocked: updatePlan.blocked.filter((item) => extensionBlockKinds().has(item.kind)),
      warnings: updatePlan.warnings,
    },
  };
  if (ctx.json || options.json) {
    printJson(data);
    if (!validation.ok || managed.summary.loadFailed > 0 || (options.deep && !loadProbe?.ok)) process.exitCode = 1;
    return;
  }
  section("pi-67 extensions doctor");
  if (validation.ok) pass(validation.message);
  else {
    for (const problem of validation.problems) fail(problem);
    process.exitCode = 1;
  }
  for (const warning of validation.warnings) warn(warning);
  if (options.deep) {
    if (loadProbe?.ok) pass(`pi list resolved ${loadProbe.loadedSpecs.length} configured packages`);
    else {
      fail(`pi list load probe failed${loadProbe?.error ? `: ${loadProbe.error}` : ""}`);
      process.exitCode = 1;
    }
  }
  printManagedSummary(managed);
  for (const item of managed.extensions.filter((entry) => entry.status !== "at-baseline")) {
    const message = `${item.id}: ${item.status}; action=${item.action}; installed=${item.installedVersion || item.installedCommit || "missing"}; baseline=${item.minimumVersion || item.minimumCommit}`;
    if (item.status === "load-failed") {
      fail(`${message}; ${item.loadFailure}`);
      process.exitCode = 1;
    } else if (item.action === "keep-conflict") warn(message);
    else info(message);
  }
}

function inspect(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printExtensionsHelp();
  const id = positionals[0];
  if (!id) throw new CliError("extensions inspect requires an extension id", 2);
  const sourceRoot = resolveDistroSourceRoot(ctx);
  const managed = inspectManagedExtensions(ctx, { sourceRoot, deepHash: true });
  const baseline = managed.extensions.find((item) => item.id === id) || null;
  const manifest = buildDistroManifest(ctx);
  const governance = manifest.extensionRegistry.extensions.find((item) => item.id === id) || null;
  if (!baseline && !governance) throw new CliError(`unknown extension: ${id}`, 2);
  const data = {
    schema: "pi67.extensions-inspect.v2",
    createdAt: new Date().toISOString(),
    baseline,
    governance,
  };
  if (ctx.json || options.json) return printJson(data);
  section(`pi-67 extension: ${id}`);
  if (baseline) {
    keyValue("Status", baseline.status);
    keyValue("Action", baseline.action);
    keyValue("Source", baseline.sourceKind);
    keyValue("Installed", baseline.installedVersion || baseline.installedCommit || "missing");
    keyValue("Minimum baseline", baseline.minimumVersion || baseline.minimumCommit);
  }
  if (governance) {
    keyValue("Owner", governance.owner);
    keyValue("Update policy", governance.updateStrategy);
  }
}

async function plan(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "strict-shared-skills", "no-remote"],
  });
  if (options.help) return printExtensionsHelp();
  const sourceRoot = resolveDistroSourceRoot(ctx);
  const updatePlan = await buildUpdatePlan(ctx, {
    noRemote: ctx.noRemote || options.noRemote,
    strictSharedSkills: options.strictSharedSkills,
    sourceRoot,
  });
  const data = {
    schema: "pi67.extensions-plan.v2",
    createdAt: new Date().toISOString(),
    status: updatePlan.extensions,
    actions: updatePlan.actions.filter((item) => extensionActionKinds().has(item.kind)),
    blocked: updatePlan.blocked.filter((item) => extensionBlockKinds().has(item.kind)),
    warnings: updatePlan.warnings,
  };
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 extension update plan");
  printManagedSummary(data.status);
  for (const action of data.actions) info(`${action.id}: ${action.operation}`);
  for (const blocked of data.blocked) warn(`${blocked.id}: ${blocked.reason}`);
  for (const warning of data.warnings) warn(warning);
  if (data.actions.length === 0 && data.blocked.length === 0) pass("no extension-related action is required");
}

function status(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json", "deep"] });
  if (options.help) return printExtensionsHelp();
  const loadProbe = options.deep ? probePiExtensionLoads(ctx) : null;
  const data = inspectManagedExtensions(ctx, {
    sourceRoot: resolveDistroSourceRoot(ctx),
    deepHash: options.deep,
    loadProbe,
  });
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 default extension status");
  printManagedSummary(data);
  keyValue("Unknown user-managed", data.summary.unknown);
  if (options.deep) keyValue("Pi load probe", loadProbe?.ok ? "pass" : "failed");
  for (const item of data.extensions) info(`${item.id}: ${item.status}; action=${item.action}`);
}

function diff(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printExtensionsHelp();
  const id = positionals[0];
  if (!id) throw new CliError("extensions diff requires an extension id", 2);
  const data = diffManagedExtension(ctx, id, { sourceRoot: resolveDistroSourceRoot(ctx) });
  if (ctx.json || options.json) return printJson(data);
  section(`pi-67 extension diff: ${id}`);
  keyValue("Status", data.extension.status);
  keyValue("Action", data.extension.action);
  keyValue("Installed", data.extension.installedVersion || data.extension.installedCommit || "missing");
  keyValue("Baseline", data.extension.minimumVersion || data.extension.minimumCommit);
  keyValue("Automatic action safe", data.safeAutomaticAction ? "yes" : "no");
}

function restore(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["check", "dry-run", "json", "yes"],
  });
  if (options.help) return printExtensionsHelp();
  const id = positionals[0];
  if (!id) throw new CliError("extensions restore requires an extension id", 2);
  const dryRun = ctx.dryRun || options.dryRun || options.check;
  if (!dryRun && !(ctx.yes || options.yes)) {
    throw new CliError("extensions restore replaces the selected extension after backup; preview with --check, then confirm with --yes", 2);
  }
  const data = restoreManagedExtension(ctx, id, {
    dryRun,
    sourceRoot: resolveDistroSourceRoot(ctx),
  });
  if (ctx.json || options.json) return printJson(data);
  section(`pi-67 extension restore: ${id}`);
  keyValue("Dry run", dryRun ? "yes" : "no");
  keyValue("Action", data.action || "backup-and-restore-baseline");
  if (data.backupDir) keyValue("Backup", data.backupDir);
}

function updateHint(_ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["dry-run"] });
  if (options.help) return printExtensionsHelp();
  const id = positionals[0] || "<id>";
  throw new CliError([
    "Generic extension overwrite updates are intentionally unsupported.",
    "Run `pi-67 update` for missing/safely-behind defaults.",
    `Run \`pi-67 extensions restore ${id} --check\` for an explicit replacement preview.`,
    `Run \`pi-67 external update ${id}\` for an external repo.`,
  ].join("\n"), 2);
}

function printManagedSummary(data) {
  const summary = data.summary;
  keyValue("Total", summary.total);
  keyValue("At baseline", summary.atBaseline);
  keyValue("Missing", summary.missing);
  keyValue("Safely behind", summary.belowBaseline);
  keyValue("Ahead preserved", summary.userManagedAhead);
  keyValue("Modified preserved", summary.userManagedDiverged);
  keyValue("Load failed", summary.loadFailed);
}

function extensionActionKinds() {
  return new Set(["managed-extension-baseline", "theme-package", "skill-pack"]);
}

function extensionBlockKinds() {
  return new Set(["external-repo", "skill-pack"]);
}

function printExtensionsHelp() {
  process.stdout.write(`pi-67 extensions - inspect and govern default extension baselines

Usage:
  pi-67 extensions list [--json]
  pi-67 extensions doctor [--json] [--deep] [--strict-shared-skills]
  pi-67 extensions inspect <id> [--json]
  pi-67 extensions plan [--json]
  pi-67 extensions status [--json] [--deep]
  pi-67 extensions diff <id> [--json]
  pi-67 extensions restore <id> --check [--json]
  pi-67 extensions restore <id> --yes

Normal update installs missing and safely-behind defaults, but never downgrades
newer extensions or overwrites modified/diverged extensions. Explicit restore
backs up and replaces only the selected extension.
`);
}
