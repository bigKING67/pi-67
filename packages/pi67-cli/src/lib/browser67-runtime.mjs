import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { captureCommand, runCommand } from "./shell-runner.mjs";
import { replaceFileSafely } from "./xtalpi-config.mjs";

const require = createRequire(import.meta.url);
const { normalizeMcpConfig } = require("../../../../scripts/pi67-mcp-config-utils.cjs");

const REQUIRED_SKILLS = ["browser67", "js-reverse"];
const BROWSER_ENTRYPOINT = "src/mcp/browser/server.mjs";
const JS_REVERSE_ENTRYPOINT = "src/mcp/js-reverse/server.mjs";

export function setupBrowser67(ctx, options = {}) {
  const root = path.resolve(options.root || path.join(ctx.packagesDir, "browser67"));
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);
  const run = options.runCommand || runCommand;
  const steps = [];

  assertBrowser67Checkout(root, { dryRun });
  runStep(run, steps, "dependencies", "npm", ["ci"], { cwd: root, dryRun, quiet });
  runStep(run, steps, "extension-setup", "npm", ["run", "setup"], { cwd: root, dryRun, quiet });
  runStep(run, steps, "active-skills", "npm", ["run", "skills:active:sync", "--", "--target", ctx.skillsDir], {
    cwd: root,
    dryRun,
    quiet,
  });

  const mcp = configureBrowser67Mcp(ctx, root, { dryRun });
  steps.push({ id: "mcp-config", action: mcp.changed ? "update" : "current", ...mcp });

  if (options.startHub) {
    runStep(run, steps, "hub-start", "npm", ["run", "hub:start"], { cwd: root, dryRun, quiet });
  }

  return {
    schema: "pi67.browser67-setup.v1",
    root,
    dryRun,
    startHub: Boolean(options.startHub),
    steps,
    manualSteps: [
      `Load the unpacked Chrome/Edge extension from: ${path.join(resolveBrowser67Home(), "browser", "tmwd_cdp_bridge")}`,
      options.startHub ? "Confirm the extension is connected to the running hub." : `Start the hub when ready: cd ${root} && npm run hub:start`,
      "Close old Pi processes and start a fresh Pi session so the MCP config is reloaded.",
      "Verify with: pi-67 external doctor browser67 --deep",
    ],
  };
}

export function inspectBrowser67Runtime(ctx, options = {}) {
  const root = path.resolve(options.root || path.join(ctx.packagesDir, "browser67"));
  const browserHome = resolveBrowser67Home(options);
  const extensionDir = path.join(browserHome, "browser", "tmwd_cdp_bridge");
  const mcpFile = path.join(ctx.agentDir, "mcp.json");
  const checks = [
    fileCheck("checkout", root, "browser67 checkout exists", "run pi-67 external install browser67"),
    fileCheck("package-json", path.join(root, "package.json"), "browser67 package.json exists", "reinstall the browser67 checkout"),
    fileCheck("dependencies", path.join(root, "node_modules"), "browser67 dependencies are installed", `cd ${root} && npm ci`),
    fileCheck("browser-entrypoint", path.join(root, BROWSER_ENTRYPOINT), "tmwd_browser MCP entrypoint exists", "update or reinstall browser67"),
    fileCheck("js-reverse-entrypoint", path.join(root, JS_REVERSE_ENTRYPOINT), "js-reverse MCP entrypoint exists", "update or reinstall browser67"),
    fileCheck("extension", path.join(extensionDir, "manifest.json"), "browser extension runtime is prepared", `cd ${root} && npm run setup`),
    ...REQUIRED_SKILLS.map((name) => fileCheck(
      `skill-${name}`,
      path.join(ctx.skillsDir, name, "SKILL.md"),
      `${name} active skill is installed`,
      `cd ${root} && npm run skills:active:sync -- --target ${ctx.skillsDir}`,
    )),
  ];

  const mcp = inspectBrowser67Mcp(mcpFile, root);
  checks.push(...mcp.checks);
  const deterministicReady = checks.every((check) => check.ok);
  const live = options.deep
    ? inspectBrowser67Live(root, { captureCommand: options.captureCommand, timeoutMs: options.timeoutMs })
    : { attempted: false, ok: null, result: null, error: "" };

  return {
    schema: "pi67.browser67-runtime.v1",
    root,
    browserHome,
    extensionDir,
    mcpFile,
    checks,
    deterministicReady,
    deep: Boolean(options.deep),
    live,
    ready: deterministicReady && (!options.deep || live.ok === true),
    nextSteps: dedupe(checks.filter((check) => !check.ok).map((check) => check.fix)),
  };
}

export function configureBrowser67Mcp(ctx, root, options = {}) {
  const file = path.join(ctx.agentDir, "mcp.json");
  const existed = fs.existsSync(file);
  const config = existed ? readJson(file) : { mcpServers: {} };
  const normalized = normalizeMcpConfig(config, {
    agentDir: ctx.agentDir,
    browser67Root: root,
  });

  if (!normalized.changed) {
    return { file, changed: false, changes: [], backup: "", created: false };
  }
  if (options.dryRun) {
    return { file, changed: true, changes: normalized.changes, backup: "", created: !existed, dryRun: true };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = "";
  if (existed) {
    const backupDir = path.join(ctx.stateDir, "backups", "browser67-mcp");
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, `${timestamp()}-mcp.json`);
    fs.copyFileSync(file, backup);
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      // Windows and some filesystems do not expose POSIX modes.
    }
  }
  writeJsonAtomic(file, normalized.config);
  return { file, changed: true, changes: normalized.changes, backup, created: !existed };
}

export function resolveBrowser67Home(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const explicit = env.BROWSER67_HOME || env.TMWD_BROWSER_MCP_HOME || env.TMWD_HOME;
  if (explicit) return expandHome(explicit, home);
  const canonical = path.join(home, ".browser67");
  if (fs.existsSync(canonical)) return canonical;
  const legacy = path.join(home, ".tmwd-browser-mcp");
  if (fs.existsSync(legacy)) return legacy;
  return canonical;
}

function inspectBrowser67Mcp(file, root) {
  if (!fs.existsSync(file)) {
    return {
      checks: [check("mcp-config", false, "Pi MCP config is missing", `run pi-67 external setup browser67`)],
    };
  }
  let config;
  try {
    config = readJson(file);
  } catch (error) {
    return {
      checks: [check("mcp-config", false, `Pi MCP config is invalid JSON: ${error.message}`, "repair mcp.json before retrying")],
    };
  }
  const servers = config.mcpServers || {};
  const tmwd = mcpServerCheck("tmwd_browser", servers.tmwd_browser, root, BROWSER_ENTRYPOINT);
  const jsReverse = mcpServerCheck("js-reverse", servers["js-reverse"], root, JS_REVERSE_ENTRYPOINT);
  const sameRoot = Boolean(tmwd.configuredRoot && jsReverse.configuredRoot && tmwd.configuredRoot === jsReverse.configuredRoot);
  return {
    checks: [
      tmwd,
      jsReverse,
      check(
        "mcp-root-consistency",
        sameRoot,
        sameRoot ? "tmwd_browser and js-reverse use the same browser67 checkout" : "tmwd_browser and js-reverse use different checkouts",
        "run pi-67 external setup browser67",
      ),
    ],
  };
}

function mcpServerCheck(name, server, root, entrypoint) {
  if (!server || typeof server !== "object") {
    return check(`mcp-${name}`, false, `${name} MCP server is not configured`, "run pi-67 external setup browser67");
  }
  const cwd = resolveConfiguredPath(server.cwd);
  const args = Array.isArray(server.args) ? server.args : [];
  const resolvedEntrypoint = resolveMcpEntrypoint(args[0], cwd);
  const configuredRoot = browser67RootFromEntrypoint(resolvedEntrypoint, entrypoint);
  const packageName = readPackageName(configuredRoot);
  const ok = packageName === "browser67" && fs.existsSync(resolvedEntrypoint);
  const alternate = ok && configuredRoot !== path.resolve(root);
  return check(
    `mcp-${name}`,
    ok,
    ok
      ? `${name} MCP points at ${alternate ? "an alternate valid" : "the managed"} browser67 checkout`
      : `${name} MCP path or entrypoint is not a valid browser67 checkout`,
    "run pi-67 external setup browser67",
    { cwd: server.cwd || "", resolvedCwd: cwd, configuredRoot, resolvedEntrypoint, args, alternate },
  );
}

function inspectBrowser67Live(root, options = {}) {
  if (!fs.existsSync(path.join(root, "package.json"))) {
    return { attempted: false, ok: false, result: null, error: "browser67 checkout is not ready" };
  }
  const capture = options.captureCommand || captureCommand;
  const result = capture("npm", ["run", "--silent", "doctor:json"], {
    cwd: root,
    timeoutMs: Number(options.timeoutMs || 30000),
  });
  const parsed = parseJsonOutput(result.stdout);
  return {
    attempted: true,
    ok: Boolean(result.ok && parsed && (parsed.ok === true || parsed.ready === true)),
    result: parsed,
    error: result.ok ? "" : String(result.stderr || result.error || `browser67 doctor exited with ${result.status}`).trim(),
  };
}

function assertBrowser67Checkout(root, options = {}) {
  if (options.dryRun) return;
  const packageFile = path.join(root, "package.json");
  if (!fs.existsSync(packageFile)) {
    throw new Error(`browser67 checkout is missing or incomplete: ${root}`);
  }
  const pkg = readJson(packageFile);
  if (pkg.name !== "browser67") {
    throw new Error(`external checkout is not browser67: ${root}`);
  }
}

function runStep(run, steps, id, command, args, options) {
  run(command, args, options);
  steps.push({ id, action: options.dryRun ? "planned" : "completed", command, args, cwd: options.cwd });
}

function fileCheck(id, file, message, fix) {
  const ok = fs.existsSync(file);
  return check(id, ok, ok ? message : `${message.replace(/ exists$| are installed$| is prepared$| is installed$/, "")} is missing`, fix, { path: file });
}

function check(id, ok, message, fix, details = {}) {
  return { id, ok: Boolean(ok), level: ok ? "PASS" : "WARN", message, fix, ...details };
}

function resolveConfiguredPath(value) {
  const text = String(value || "");
  if (!text) return "";
  return path.resolve(expandHome(text, os.homedir()));
}

function resolveMcpEntrypoint(value, cwd) {
  const raw = String(value || "");
  if (!raw) return "";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  if (!cwd) return "";
  return path.resolve(cwd, raw);
}

function browser67RootFromEntrypoint(resolvedEntrypoint, expectedRelative) {
  if (!resolvedEntrypoint) return "";
  const expectedParts = expectedRelative.split("/");
  const actualParts = path.normalize(resolvedEntrypoint).split(path.sep);
  const tail = actualParts.slice(-expectedParts.length);
  const sameTail = tail.length === expectedParts.length && tail.every((part, index) => part === expectedParts[index]);
  if (!sameTail) return "";
  return actualParts.slice(0, -expectedParts.length).join(path.sep) || path.parse(resolvedEntrypoint).root;
}

function expandHome(value, home) {
  const text = String(value || "");
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(home, text.slice(2));
  return path.resolve(text);
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPackageName(root) {
  if (!root) return "";
  try {
    return readJson(path.join(root, "package.json")).name || "";
  } catch {
    return "";
  }
}

function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    replaceFileSafely(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows and some filesystems do not expose POSIX modes.
    }
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:.]/g, "");
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
