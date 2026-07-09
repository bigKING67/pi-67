import fs from "node:fs";
import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { DEFAULT_REPO_URL } from "../lib/paths.mjs";
import { runCommand } from "../lib/shell-runner.mjs";
import { runDistroScript } from "../lib/distro-scripts.mjs";
import { isWindows } from "../lib/platform.mjs";
import { isGitRepo } from "../lib/git.mjs";
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
  const repairConfirmed = Boolean(options.repair && (options.yes || ctx.yes));

  const cloneAgent = () => {
    fs.mkdirSync(path.dirname(ctx.agentDir), { recursive: true });
    const cloneArgs = ["clone"];
    if (options.branch) cloneArgs.push("--branch", options.branch);
    cloneArgs.push(repo, ctx.agentDir);
    runCommand("git", cloneArgs, { dryRun });
    if (dryRun) {
      info(`DRY-RUN would run installer from ${ctx.agentDir}`);
      return;
    }
  };

  const missingAgent = !fs.existsSync(ctx.agentDir);
  if (missingAgent) {
    cloneAgent();
    if (dryRun) return;
  } else if (isGitRepo(ctx.agentDir)) {
    warn(`agent checkout already exists: ${ctx.agentDir}`);
  } else if (isEmptyDirectory(ctx.agentDir)) {
    info(`agent dir exists and is empty; cloning into it: ${ctx.agentDir}`);
    cloneAgent();
    if (dryRun) return;
  } else if (repairConfirmed) {
    const backupDir = nonGitAgentBackupDir(ctx);
    const backupTarget = path.join(backupDir, "agent");
    if (dryRun) {
      info(`DRY-RUN would move existing non-git agent dir to: ${backupTarget}`);
      cloneAgent();
      return;
    }
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.renameSync(ctx.agentDir, backupTarget);
    info(`Moved existing non-git agent dir to backup: ${backupTarget}`);
    try {
      cloneAgent();
    } catch (error) {
      fs.rmSync(ctx.agentDir, { recursive: true, force: true });
      fs.renameSync(backupTarget, ctx.agentDir);
      warn(`Git clone failed; restored original non-git agent dir from backup: ${ctx.agentDir}`);
      throw error;
    }
  } else {
    throw new CliError([
      `agent dir exists but is not a git checkout: ${ctx.agentDir}`,
      "",
      "This usually means Pi or a previous manual install already created ~/.pi/agent as a plain folder.",
      "pi-67 will not overwrite it silently.",
      "",
      "To preserve that folder and reinstall pi-67, run:",
      "  pi-67 install --repair --yes",
      "",
      "This moves the existing folder into ~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent,",
      "then clones the pi-67 Git checkout into ~/.pi/agent.",
      "",
      "Preview first with:",
      "  pi-67 install --repair --yes --dry-run",
    ].join("\n"));
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
    if (runtimeState.gitIndexRefreshed) {
      info("Refreshed settings.json Git index stat cache.");
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

function isEmptyDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function nonGitAgentBackupDir(ctx) {
  return path.join(ctx.stateDir, "backups", `${timestamp()}-non-git-agent-dir`);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
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
                  With --yes, also backs up a non-git agent dir before recloning.
  --yes           Confirm explicit non-git agent dir backup/reclone repair.

Examples:
  pi-67 install
  pi-67 install --dry-run
  pi-67 install --repair --yes --dry-run
  pi-67 install --repair --yes
`);
}
