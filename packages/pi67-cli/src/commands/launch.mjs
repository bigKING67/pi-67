import { CliError, info, warn } from "../lib/output.mjs";
import { captureCommand, repairWindowsGitPath, runCommand } from "../lib/shell-runner.mjs";
import { commandExists, isWindows } from "../lib/platform.mjs";

export async function launchCommand(ctx, argv) {
  const { options, piArgs } = parseLaunchArgs(argv);
  if (options.help) {
    printLaunchHelp();
    return;
  }

  const persistGitPath = Boolean(options.persistGitPath || ctx.yes);
  const repair = repairWindowsGitPath({ persistUserPath: persistGitPath });
  if (repair.found && repair.processPathPatched) {
    info(`Found Git for Windows outside PATH: ${repair.gitExe}`);
    info(`Launching upstream pi with Git directory added to child PATH: ${repair.gitDir}`);
  }
  if (repair.persisted) {
    info(`Permanently added Git directory to Windows User PATH: ${repair.gitDir}`);
    if (repair.persistence?.broadcasted) {
      info("Broadcasted the Windows environment change for newly opened terminals.");
    }
  } else if (repair.found && !persistGitPath && repair.processPathPatched) {
    warn("This launch is repaired only for the pi child process. For bare `pi`, run `pi-67 install --repair --yes` and reopen PowerShell.");
  } else if (repair.found && persistGitPath && repair.persistence && !repair.persistence.ok) {
    warn(`Could not persist Git directory to Windows User PATH: ${repair.persistence.error}`);
    warn("Continuing with the pi child process PATH repaired.");
  }

  const gitCheck = captureCommand("git", ["--version"]);
  if (!gitCheck.ok) {
    throw new CliError(missingGitMessage(gitCheck));
  }

  if (!commandExists("pi")) {
    throw new CliError([
      "upstream `pi` command was not found.",
      "",
      "Install the upstream Pi CLI first, then use the real Pi entrypoint:",
      "  npm install -g @earendil-works/pi-coding-agent",
      "  pi --version",
      "  pi",
      "",
      "Only retry `pi-67 launch` if this already-open Windows terminal still needs temporary PATH repair.",
    ].join("\n"));
  }

  runCommand("pi", piArgs, { cwd: ctx.agentDir });
}

function parseLaunchArgs(argv) {
  const options = {};
  const piArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      piArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--persist-git-path") {
      options.persistGitPath = true;
      continue;
    }
    piArgs.push(arg);
  }
  return { options, piArgs };
}

function missingGitMessage(gitCheck) {
  const detail = (gitCheck.stderr || gitCheck.error || `exit status ${gitCheck.status}`).trim();
  const windowsGuidance = [
    "Git is required before upstream `pi` can install git-based Pi packages such as `git:github.com/justhil/pi-image-gen`.",
    detail ? `git check failed: ${detail}` : "",
    "",
    "Recommended Windows repair:",
    "  npm install -g @bigking67/pi-67@latest",
    "  pi-67 install --repair --yes",
    "  close and reopen PowerShell",
    "  git --version",
    "  pi",
    "",
    "If Git is genuinely not installed:",
    "  winget install --id Git.Git -e --source winget",
    "  close and reopen PowerShell",
    "  git --version",
    "  pi",
  ];
  const otherGuidance = [
    "Git is required before upstream `pi` can install git-based Pi packages such as `git:github.com/justhil/pi-image-gen`.",
    detail ? `git check failed: ${detail}` : "",
    "",
    "Install Git, then retry:",
    "  git --version",
    "  pi",
  ];
  return (isWindows() ? windowsGuidance : otherGuidance).filter(Boolean).join("\n");
}

function printLaunchHelp() {
  process.stdout.write(`pi-67 launch - optional Windows PATH compatibility wrapper for upstream pi

Daily use should run \`pi\` directly. This helper is only for an already-open
Windows terminal that has not inherited a repaired User PATH. Without
--persist-git-path, PATH repair applies only to the child Pi process.

Usage:
  pi-67 launch [--persist-git-path] [--] [pi args...]

Options:
  --persist-git-path  On Windows, persist a discovered Git for Windows
                      directory into User PATH before launching pi.
  -h, --help          Show help

Examples:
  pi
  pi-67 launch -- --version
  pi-67 launch --persist-git-path
`);
}
