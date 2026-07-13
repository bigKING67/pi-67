import { parseCommandOptions } from "../lib/args.mjs";
import { EXTERNAL_REPOS, externalStatus, installExternal, listExternal, updateExternal } from "../lib/external-repos.mjs";
import { inspectBrowser67Runtime, setupBrowser67 } from "../lib/browser67-runtime.mjs";
import { CliError, info, keyValue, printJson, section, warn } from "../lib/output.mjs";

export async function externalCommand(ctx, argv) {
  const [sub = "list", ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === "help") {
    printExternalHelp();
    return;
  }
  if (sub === "list") return list(ctx, rest);
  if (sub === "install") return install(ctx, rest);
  if (sub === "setup") return setup(ctx, rest);
  if (sub === "update") return update(ctx, rest);
  if (sub === "doctor") return doctor(ctx, rest);
  throw new CliError(`unknown external command: ${sub}`, 2);
}

function list(ctx, argv) {
  const { options } = parseCommandOptions(argv, { bools: ["json"] });
  if (options.help) return printExternalHelp();
  const data = { schema: "pi67.external-list.v1", repos: listExternal(ctx) };
  if (ctx.json || options.json) return printJson(data);
  section("pi-67 external repos");
  for (const repo of data.repos) {
    keyValue(repo.name, repo.exists ? `${repo.path} ${repo.git?.dirty ? "dirty" : "clean"}` : `missing at ${repo.path}`);
  }
}

function install(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run"] });
  if (options.help) return printExternalHelp();
  const name = positionals[0];
  assertExternalName(name);
  const json = ctx.json || options.json;
  const data = installExternal(ctx, name, { dryRun: ctx.dryRun || options.dryRun, quiet: json });
  if (json) return printJson(data);
  info(`${name}: ${data.action}`);
}

function update(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, { bools: ["json", "dry-run"] });
  if (options.help) return printExternalHelp();
  const name = positionals[0];
  assertExternalName(name);
  const json = ctx.json || options.json;
  const data = updateExternal(ctx, name, { dryRun: ctx.dryRun || options.dryRun, quiet: json });
  if (json) return printJson(data);
  info(`${name}: ${data.action}`);
}

function doctor(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["json", "deep"],
    strings: ["timeout-ms"],
  });
  if (options.help) return printExternalHelp();
  const name = positionals[0];
  assertExternalName(name);
  const status = externalStatus(ctx, name);
  const runtime = name === "browser67" && status.exists
    ? inspectBrowser67Runtime(ctx, {
        deep: options.deep,
        timeoutMs: positiveInteger(options.timeoutMs, "--timeout-ms", 30000),
      })
    : null;
  const data = {
    schema: "pi67.external-doctor.v2",
    ...status,
    runtime,
  };
  if (ctx.json || options.json) return printJson(data);
  section(`external doctor: ${name}`);
  keyValue("Path", data.path);
  keyValue("Exists", data.exists ? "yes" : "no");
  if (!data.exists) {
    warn(`Run: pi-67 external ${name === "browser67" ? "setup" : "install"} ${name}`);
    return;
  }
  keyValue("Git", data.git?.isRepo ? "yes" : "no");
  keyValue("Dirty", data.git?.dirty ? "yes" : "no");
  keyValue("Commit", data.git?.commit || "");
  if (runtime) {
    section("browser67 readiness");
    for (const check of runtime.checks) {
      (check.ok ? info : warn)(`${check.level} ${check.message}`);
    }
    keyValue("Deterministic", runtime.deterministicReady ? "ready" : "incomplete");
    if (runtime.deep) {
      keyValue("Live doctor", runtime.live.ok ? "ready" : "not ready");
    } else {
      info("Run `pi-67 external doctor browser67 --deep` to probe the live Hub/extension connection.");
    }
    for (const step of runtime.nextSteps) warn(`Next: ${step}`);
  }
}

function setup(ctx, argv) {
  const { options, positionals } = parseCommandOptions(argv, {
    bools: ["json", "dry-run", "start-hub"],
  });
  if (options.help) return printExternalHelp();
  const name = positionals[0];
  assertExternalName(name);
  if (name !== "browser67") {
    throw new CliError(`external setup is not implemented for ${name}; use its repository-specific install instructions`, 2);
  }
  const dryRun = ctx.dryRun || options.dryRun;
  const json = ctx.json || options.json;
  const installed = installExternal(ctx, name, { dryRun, quiet: json });
  const data = {
    install: installed,
    setup: setupBrowser67(ctx, {
      dryRun,
      quiet: json,
      startHub: options.startHub,
    }),
  };
  if (json) return printJson({ schema: "pi67.external-setup.v1", name, ...data });
  section("browser67 setup");
  keyValue("Checkout", data.setup.root);
  for (const step of data.setup.steps) info(`${step.id}: ${step.action}`);
  section("Manual completion");
  for (const step of data.setup.manualSteps) info(step);
}

function assertExternalName(name) {
  if (!name) throw new CliError(`external repo name required. Available: ${Object.keys(EXTERNAL_REPOS).join(", ")}`, 2);
  if (!EXTERNAL_REPOS[name]) throw new CliError(`unknown external repo: ${name}`, 2);
}

function printExternalHelp() {
  process.stdout.write(`pi-67 external - manage external companion repositories

Usage:
  pi-67 external list [--json]
  pi-67 external install <browser67|design-craft> [--dry-run] [--json]
  pi-67 external setup browser67 [--dry-run] [--start-hub] [--json]
  pi-67 external update <browser67|design-craft> [--dry-run] [--json]
  pi-67 external doctor <browser67|design-craft> [--deep] [--timeout-ms N] [--json]

Safety:
  External repos are explicit opt-in. Dirty external repos block update instead
  of being overwritten. browser67 setup prepares dependencies, active skills,
  extension files, and MCP config, but browser loading and OS permissions stay
  explicit manual steps.

Examples:
  pi-67 external list
  pi-67 external install browser67 --dry-run
  pi-67 external setup browser67 --dry-run
  pi-67 external doctor browser67 --deep
  pi-67 external doctor design-craft
`);
}

function positiveInteger(value, name, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError(`${name} must be an integer >= 1`, 2);
  return parsed;
}
