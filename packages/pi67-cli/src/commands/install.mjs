import fs from "node:fs";
import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { DEFAULT_REPO_URL } from "../lib/paths.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";
import { CliError, info, warn } from "../lib/output.mjs";
import { writeState } from "../lib/state-store.mjs";
import { migrateSettingsRuntimeState } from "../lib/settings-runtime-state.mjs";

export async function installCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    strings: ["repo", "branch"],
    bools: ["dry-run", "yes", "repair"],
  });
  if (options.help) {
    printInstallHelp();
    return;
  }
  const dryRun = ctx.dryRun || options.dryRun;
  const repo = options.repo || DEFAULT_REPO_URL;

  const missingAgent = !fs.existsSync(ctx.agentDir);
  if (missingAgent) {
    fs.mkdirSync(path.dirname(ctx.agentDir), { recursive: true });
    const cloneArgs = ["clone"];
    if (options.branch) cloneArgs.push("--branch", options.branch);
    cloneArgs.push(repo, ctx.agentDir);
    runCommand("git", cloneArgs, { dryRun });
    if (dryRun) {
      info(`DRY-RUN would run installer from ${ctx.agentDir}`);
      return;
    }
  } else if (!fs.existsSync(path.join(ctx.agentDir, ".git"))) {
    throw new CliError(`agent dir exists but is not a git checkout: ${ctx.agentDir}`);
  } else {
    warn(`agent checkout already exists: ${ctx.agentDir}`);
  }

  if (isWindows()) {
    const args = ["-AgentDir", ctx.agentDir, "-RepoRoot", ctx.repoRoot, "-SkillsDir", ctx.skillsDir];
    if (dryRun) args.push("-DryRun");
    if (options.repair) args.push("-ForceNpm");
    runDistroScript(ctx, { sh: "pi67-update.sh", ps1: "pi67-update.ps1" }, args, { dryRun: false });
  } else {
    const args = ["--agent-dir", ctx.agentDir, "--skills-dir", ctx.skillsDir, "--yes"];
    if (dryRun) args.push("--dry-run");
    runCommand("bash", [path.join(ctx.repoRoot, "install.sh"), ...args], { cwd: ctx.repoRoot, dryRun: false });
  }
  if (!dryRun) {
    writeState(ctx, "install");
    const runtimeState = migrateSettingsRuntimeState(ctx, {
      normalizeSettingsJson: true,
      installGitFilter: true,
    });
    if (runtimeState.markerFound && runtimeState.stateWritten) {
      info("Migrated settings.json lastChangelogVersion to ignored state: ~/.pi/pi67/state.json");
    }
    if (runtimeState.settingsNormalized) {
      info("Normalized settings.json runtime marker/line endings.");
    }
    if (runtimeState.gitFilterInstalled) {
      info("Installed local git clean filter for future settings.json runtime markers.");
    }
    for (const error of runtimeState.errors) {
      warn(`settings runtime marker migration skipped: ${error}`);
    }
  }
  info("Install finished. Run `pi-67 doctor` next.");
}

function printInstallHelp() {
  process.stdout.write(`pi-67 install - clone/install pi-67 safely

Usage:
  pi-67 install [--repo URL] [--branch NAME] [--dry-run] [--repair]

Options:
  --repo URL      Git repository URL. Defaults to the pi-67 upstream repo.
  --branch NAME   Clone a specific branch.
  --dry-run       Print planned writes without changing files.
  --repair        Force owned asset repair during the installer update phase.

Examples:
  pi-67 install
  pi-67 install --dry-run
`);
}
