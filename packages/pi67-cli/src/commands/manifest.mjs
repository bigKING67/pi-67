import { parseCommandOptions } from "../lib/args.mjs";
import { buildDistroManifest } from "../lib/distro-manifest.mjs";
import { validateExtensionRegistry } from "../lib/extension-registry.mjs";
import { fail, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function manifestCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "validate"],
  });
  if (options.help) {
    printManifestHelp();
    return;
  }
  const manifest = buildDistroManifest(ctx);
  const validation = validateExtensionRegistry(manifest.extensionRegistry, { manifest });
  if (ctx.json || options.json) {
    printJson(options.validate ? {
      schema: "pi67.manifest-validation.v1",
      createdAt: manifest.createdAt,
      extensionRegistry: validation,
    } : manifest);
    if (options.validate && !validation.ok) process.exitCode = 1;
    return;
  }
  if (options.validate) {
    printValidation(validation);
    return;
  }
  section("pi-67 distro manifest");
  keyValue("Dependencies", manifest.summary.dependencies);
  keyValue("Upstream Pi tested", manifest.upstreamPi?.testedVersion || "unknown");
  keyValue("Upstream Pi ownership", `${manifest.upstreamPi?.owner || "unknown"}: ${manifest.upstreamPi?.mutationPolicy || "unknown"}`);
  keyValue("Runtime packages", `${manifest.summary.pi67ManagedRuntimePackages} pi67-managed, ${manifest.summary.userManagedRuntimePackages} user-managed`);
  keyValue("Local extensions", `${manifest.summary.localExtensions - manifest.summary.missingLocalExtensions}/${manifest.summary.localExtensions} present`);
  keyValue("Registered extensions", manifest.summary.registeredExtensions);
  keyValue("Shared skills", `${manifest.sharedSkills.sourceDir} -> ${manifest.sharedSkills.activeDir}`);
  keyValue("Theme policy", `${manifest.theme.packageName}: ${manifest.theme.policy}`);
  keyValue("Preserved runtime files", manifest.runtimeFiles.preserve.join(", "));

  section("Update boundary");
  info(`pi-67 update command: ${manifest.commands.update}`);
  info(`Repair command: ${manifest.commands.repair}`);
  info(`Always-fresh update: ${manifest.commands.alwaysFreshUpdate}`);
  info(`Always-fresh repair: ${manifest.commands.alwaysFreshRepair}`);
  warn(`Upstream Pi runtime update is separate: ${manifest.upstreamPi.updateCommand}`);
  warn(`${manifest.commands.upstreamPiExtensions} is only for user-managed upstream Pi extensions; pi-67-managed extensions use pi-67 update.`);

  section("Local extensions");
  for (const item of manifest.localExtensions) {
    if (item.exists && item.owner === "pi67-managed") pass(`${item.name}: ${item.path}`);
    else if (item.exists) info(`${item.name}: ${item.path} (${item.owner}; ${item.policy})`);
    else warn(`${item.name}: missing ${item.path}`);
  }

  section("Extension registry");
  for (const item of manifest.extensionRegistry.extensions) {
    info(`${item.id}: ${item.kind}; update=${item.updateStrategy}; repair=${item.repairStrategy}`);
  }
  if (validation.ok) pass("extension registry policy ready");
  else warn(`extension registry policy drift: ${validation.message}`);

  if (manifest.userManagedPackages.length > 0) {
    section("User-managed runtime packages");
    for (const item of manifest.userManagedPackages) {
      warn(`${item.spec} is report-only; pi-67 will not overwrite it by default.`);
    }
  }
}

function printValidation(validation) {
  section("pi-67 manifest validation");
  keyValue("Registry entries", validation.summary.entries);
  keyValue("Smoke gates", validation.summary.smokeGates);
  keyValue("Config patches", validation.summary.configPatches);
  if (validation.ok) {
    pass(validation.message);
  } else {
    for (const problem of validation.problems) fail(problem);
    process.exitCode = 1;
  }
  for (const warning of validation.warnings) warn(warning);
}

function printManifestHelp() {
  process.stdout.write(`pi-67 manifest - show managed ownership policy

Usage:
  pi-67 manifest [--json]
  pi-67 manifest --validate [--json]

Options:
  --validate  Validate the extension registry against the distro manifest.
  --json      Emit machine-readable manifest or validation JSON.

Examples:
  pi-67 manifest
  pi-67 manifest --validate
`);
}
