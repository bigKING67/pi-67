#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultHome() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) || /^wss?:\/\//i.test(String(value || ""));
}

function startsWithHomePlaceholder(value) {
  return /^(?:~|\$HOME|\$\{HOME\}|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%)(?=$|[\\/])/i.test(String(value || ""));
}

function hasAdapterUnsupportedPlaceholder(value, field = "args") {
  const text = String(value || "");
  if (!text || isUrl(text)) return false;

  if (field === "cwd") {
    // pi-mcp-adapter resolves "~", "${VAR}", and "$env:VAR" for cwd, but not "$HOME".
    return /^\$HOME(?=$|[\\/])/i.test(text) || /^%USERPROFILE%(?=$|[\\/])/i.test(text);
  }

  if (field === "env") {
    // Env values use pi-mcp-adapter interpolateEnvVars: ${VAR} and $env:VAR only.
    return /^(?:~|\$HOME|%USERPROFILE%)(?=$|[\\/])/i.test(text);
  }

  // command and args are passed directly to child_process spawn; no shell/home expansion.
  return startsWithHomePlaceholder(text);
}

function expandHomePrefix(value, home = defaultHome()) {
  const text = String(value || "");
  if (!text) return text;
  const normalizedHome = path.resolve(home || defaultHome());
  return text
    .replace(/^~(?=$|[\\/])/, normalizedHome)
    .replace(/^\$HOME(?=$|[\\/])/, normalizedHome)
    .replace(/^\$\{HOME\}(?=$|[\\/])/, normalizedHome)
    .replace(/^\$env:(?:HOME|USERPROFILE)(?=$|[\\/])/i, normalizedHome)
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, normalizedHome);
}

function absolutePath(value, options = {}) {
  const home = options.home || defaultHome();
  const baseDir = options.baseDir || process.cwd();
  const expanded = expandHomePrefix(value, home);
  if (!expanded) return expanded;
  return path.resolve(baseDir, expanded);
}

function normalizeHomePathValue(value, options = {}) {
  if (typeof value !== "string" || !value || isUrl(value)) return value;
  if (!startsWithHomePlaceholder(value)) return value;
  return absolutePath(value, options);
}

function ensureObject(root, key) {
  if (!root[key] || typeof root[key] !== "object" || Array.isArray(root[key])) {
    root[key] = {};
  }
  return root[key];
}

function setChanged(target, key, value, label, changes) {
  if (target[key] === value) return;
  const before = target[key];
  target[key] = value;
  changes.push(`${label}: ${before === undefined ? "(unset)" : before} -> ${value}`);
}

function normalizeMcpConfig(config, options = {}) {
  const home = options.home || defaultHome();
  const agentDir = options.agentDir || process.cwd();
  const changes = [];
  const mcpServers = ensureObject(config, "mcpServers");

  if (options.browser67Root) {
    const root = absolutePath(options.browser67Root, { home, baseDir: agentDir });
    const tmwd = ensureObject(mcpServers, "tmwd_browser");
    const jsReverse = ensureObject(mcpServers, "js-reverse");
    setChanged(tmwd, "command", tmwd.command || "node", "tmwd_browser.command", changes);
    setChanged(jsReverse, "command", jsReverse.command || "node", "js-reverse.command", changes);
    const tmwdArgs = [path.join(root, "src", "mcp", "browser", "server.mjs")];
    const jsArgs = [path.join(root, "src", "mcp", "js-reverse", "server.mjs")];
    if (JSON.stringify(tmwd.args || []) !== JSON.stringify(tmwdArgs)) {
      tmwd.args = tmwdArgs;
      changes.push(`tmwd_browser.args: set absolute browser67 MCP entrypoint`);
    }
    if (JSON.stringify(jsReverse.args || []) !== JSON.stringify(jsArgs)) {
      jsReverse.args = jsArgs;
      changes.push(`js-reverse.args: set absolute browser67 MCP entrypoint`);
    }
  }

  if (options.agentMemoryBin) {
    const agentMemory = ensureObject(mcpServers, "agent_memory");
    setChanged(
      agentMemory,
      "command",
      absolutePath(options.agentMemoryBin, { home, baseDir: agentDir }),
      "agent_memory.command",
      changes
    );
    if (!Array.isArray(agentMemory.args)) {
      agentMemory.args = [];
      changes.push("agent_memory.args: set empty args array");
    }
  }

  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) continue;

    const normalizedCommand = normalizeHomePathValue(server.command, { home, baseDir: agentDir });
    if (normalizedCommand !== server.command) {
      server.command = normalizedCommand;
      changes.push(`${name}.command: expanded home placeholder to absolute path`);
    }

    const normalizedCwd = normalizeHomePathValue(server.cwd, { home, baseDir: agentDir });
    if (normalizedCwd !== server.cwd) {
      server.cwd = normalizedCwd;
      changes.push(`${name}.cwd: expanded home placeholder to absolute path`);
    }

    if (Array.isArray(server.args)) {
      const nextArgs = server.args.map((arg) => normalizeHomePathValue(arg, {
        home,
        baseDir: resolveAdapterCwd(server.cwd, agentDir, home),
      }));
      if (JSON.stringify(nextArgs) !== JSON.stringify(server.args)) {
        server.args = nextArgs;
        changes.push(`${name}.args: expanded home placeholders to absolute paths`);
      }
    }

    if (server.env && typeof server.env === "object" && !Array.isArray(server.env)) {
      for (const [key, value] of Object.entries(server.env)) {
        const normalized = normalizeHomePathValue(value, { home, baseDir: agentDir });
        if (normalized !== value) {
          server.env[key] = normalized;
          changes.push(`${name}.env.${key}: expanded home placeholder to absolute path`);
        }
      }
    }
  }

  return { config, changed: changes.length > 0, changes };
}

function adapterInterpolateEnvVars(value) {
  return String(value || "")
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/gi, (_, name) => process.env[name] ?? "");
}

function resolveAdapterCwd(cwd, defaultCwd, home = defaultHome()) {
  if (!cwd) return defaultCwd;
  const resolved = adapterInterpolateEnvVars(cwd);
  if (resolved === "~") return home;
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return path.join(home, resolved.slice(2));
  }
  return resolved;
}

function commandExistsForAdapter(command, server = {}, options = {}) {
  const home = options.home || defaultHome();
  const cwd = resolveAdapterCwd(server.cwd, options.agentDir || process.cwd(), home);
  const raw = String(command || "");
  if (!raw) return { exists: false, label: "", unsupported: false };
  if (hasAdapterUnsupportedPlaceholder(raw, "command")) {
    return { exists: false, label: raw, unsupported: true };
  }
  if (raw.includes("/") || raw.includes("\\")) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    return { exists: fs.existsSync(resolved), label: resolved, unsupported: false };
  }
  const found = String(process.env.PATH || "")
    .split(path.delimiter)
    .some((dir) => fs.existsSync(path.join(dir, raw)));
  return { exists: found, label: raw, unsupported: false };
}

function resolvePathArgForAdapter(arg, server = {}, options = {}) {
  const raw = String(arg || "");
  const home = options.home || defaultHome();
  if (!raw || isUrl(raw)) return { path: raw, checkable: false, unsupported: false };
  if (hasAdapterUnsupportedPlaceholder(raw, "args")) {
    return { path: raw, checkable: true, unsupported: true };
  }
  if (!raw.includes("/") && !raw.includes("\\") && !path.isAbsolute(raw)) {
    return { path: raw, checkable: false, unsupported: false };
  }
  const cwd = resolveAdapterCwd(server.cwd, options.agentDir || process.cwd(), home);
  return {
    path: path.isAbsolute(raw) ? raw : path.resolve(cwd, raw),
    checkable: true,
    unsupported: false,
  };
}

function adapterRuntimeIssues(config, options = {}) {
  const issues = [];
  const servers = config.mcpServers || {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) continue;
    if (hasAdapterUnsupportedPlaceholder(server.command, "command")) {
      issues.push({ server: name, field: "command", value: server.command });
    }
    if (hasAdapterUnsupportedPlaceholder(server.cwd, "cwd")) {
      issues.push({ server: name, field: "cwd", value: server.cwd });
    }
    for (const arg of server.args || []) {
      if (hasAdapterUnsupportedPlaceholder(arg, "args")) {
        issues.push({ server: name, field: "args", value: arg });
      }
    }
    for (const [key, value] of Object.entries(server.env || {})) {
      if (hasAdapterUnsupportedPlaceholder(value, "env")) {
        issues.push({ server: name, field: `env.${key}`, value });
      }
    }
  }
  return issues;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function parseCli(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      options._.push(item);
      continue;
    }
    const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (["normalize", "checkRuntime", "inspectRuntime", "dryRun", "json"].includes(key)) {
      options[key] = true;
    } else {
      options[key] = argv[++i];
    }
  }
  return options;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const file = options.file || options._[0];
  if (!file || (!options.normalize && !options.checkRuntime && !options.inspectRuntime)) {
    console.error("Usage: pi67-mcp-config-utils.cjs --normalize|--check-runtime|--inspect-runtime --file mcp.json [--agent-dir DIR] [--browser67-root DIR] [--agent-memory-bin FILE] [--dry-run] [--json]");
    process.exit(2);
  }

  const config = readJson(file);
  let normalized = { changed: false, changes: [] };
  if (options.normalize) {
    normalized = normalizeMcpConfig(config, {
      agentDir: options.agentDir || path.dirname(file),
      browser67Root: options.browser67Root,
      agentMemoryBin: options.agentMemoryBin,
    });
    if (normalized.changed && !options.dryRun) {
      writeJson(file, normalized.config);
    }
  }
  const issues = adapterRuntimeIssues(config, { agentDir: options.agentDir || path.dirname(file) });

  const result = {
    schema: "pi67.mcp-config-utils.v1",
    file,
    changed: normalized.changed,
    changes: normalized.changes,
    issues,
    ok: issues.length === 0,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const change of normalized.changes) console.log(`changed: ${change}`);
    for (const issue of issues) console.log(`issue: ${issue.server}.${issue.field} uses unsupported runtime placeholder: ${issue.value}`);
    if (!normalized.changed && issues.length === 0) console.log("mcp config ok");
  }

  if (options.checkRuntime && issues.length > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  adapterInterpolateEnvVars,
  adapterRuntimeIssues,
  absolutePath,
  commandExistsForAdapter,
  defaultHome,
  expandHomePrefix,
  hasAdapterUnsupportedPlaceholder,
  isUrl,
  normalizeMcpConfig,
  resolveAdapterCwd,
  resolvePathArgForAdapter,
  startsWithHomePlaceholder,
};
