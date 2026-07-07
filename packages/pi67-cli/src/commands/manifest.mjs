import { parseCommandOptions } from "../lib/args.mjs";
import { buildDistroManifest } from "../lib/distro-manifest.mjs";
import { info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function manifestCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json"],
  });
  const manifest = buildDistroManifest(ctx);
  if (ctx.json || options.json) {
    printJson(manifest);
    return;
  }
  section("pi-67 distro manifest");
  keyValue("Dependencies", manifest.summary.dependencies);
  keyValue("Runtime packages", `${manifest.summary.pi67ManagedRuntimePackages} pi67-managed, ${manifest.summary.userManagedRuntimePackages} user-managed`);
  keyValue("Local extensions", `${manifest.summary.localExtensions - manifest.summary.missingLocalExtensions}/${manifest.summary.localExtensions} present`);
  keyValue("Registered extensions", manifest.summary.registeredExtensions);
  keyValue("Shared skills", `${manifest.sharedSkills.sourceDir} -> ${manifest.sharedSkills.activeDir}`);
  keyValue("Theme policy", `${manifest.theme.packageName}: ${manifest.theme.policy}`);
  keyValue("Preserved runtime files", manifest.runtimeFiles.preserve.join(", "));

  section("Update boundary");
  info(`pi-67 update command: ${manifest.commands.update}`);
  info(`Repair command: ${manifest.commands.repair}`);
  info(`Always-fresh repair: ${manifest.commands.alwaysFreshRepair}`);
  warn(`${manifest.commands.upstreamPiExtensions} is upstream Pi only; it is not the pi-67 distribution updater.`);

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

  if (manifest.userManagedPackages.length > 0) {
    section("User-managed runtime packages");
    for (const item of manifest.userManagedPackages) {
      warn(`${item.spec} is report-only; pi-67 will not overwrite it by default.`);
    }
  }
}
