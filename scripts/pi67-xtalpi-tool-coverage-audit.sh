#!/usr/bin/env bash
set -euo pipefail

# Read-only audit for Pi extension tool surfaces visible to xtalpi-pi-tools.
# It classifies packages from settings.json into model-callable tools vs.
# command/shortcut/hook-only surfaces. It does not execute any extension tool.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$REPO_ROOT}"
OUTPUT_FORMAT="text"
OUTPUT=""
INCLUDE_TARGETS=()

usage() {
  cat <<'USAGE'
pi67-xtalpi-tool-coverage-audit audits extension tool surfaces.

Usage:
  scripts/pi67-xtalpi-tool-coverage-audit.sh [options]

Options:
      --repo-root DIR      pi-67 checkout. Defaults to parent of this script.
      --agent-dir DIR      Pi agent dir/package root. Defaults to repo root.
      --include TARGET     Include an extra expected package/tool target, even if
                           it is not listed in settings.json. Repeatable.
      --output FILE        Write output to FILE instead of stdout.
      --json               Emit machine-readable JSON.
  -h, --help               Show this help.

Examples:
  scripts/pi67-xtalpi-tool-coverage-audit.sh
  scripts/pi67-xtalpi-tool-coverage-audit.sh --json
  scripts/pi67-xtalpi-tool-coverage-audit.sh --include pi-rules-loader
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
      ;;
    --agent-dir)
      PI_AGENT_DIR="${2:?--agent-dir requires a path}"
      shift 2
      ;;
    --include)
      INCLUDE_TARGETS+=("${2:?--include requires a target}")
      shift 2
      ;;
    --output)
      OUTPUT="${2:?--output requires a file}"
      shift 2
      ;;
    --json)
      OUTPUT_FORMAT="json"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for pi67-xtalpi-tool-coverage-audit" >&2
  exit 1
fi

if [ -n "$OUTPUT" ]; then
  mkdir -p "$(dirname "$OUTPUT")"
fi

TMP_OUTPUT=""
if [ -n "$OUTPUT" ]; then
  TMP_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/.pi67-xtalpi-tool-coverage-audit.XXXXXX.tmp")"
  trap 'rm -f "$TMP_OUTPUT"' EXIT
else
  TMP_OUTPUT="/dev/stdout"
fi

NODE_ARGS=("$REPO_ROOT" "$PI_AGENT_DIR" "$OUTPUT_FORMAT")
if [ "${#INCLUDE_TARGETS[@]}" -gt 0 ]; then
  NODE_ARGS+=("${INCLUDE_TARGETS[@]}")
fi

node - "${NODE_ARGS[@]}" > "$TMP_OUTPUT" <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const [, , repoRoot, agentDir, outputFormat, ...includeTargets] = process.argv;

const KNOWN = {
  "npm:pi-subagents": {
    expectedTools: ["subagent"],
    safeSmoke: "static only; use action:list before any child execution",
    risk: "medium",
    notes: ["executes child agents; write scopes and async lifecycle need separate smoke"],
  },
  "npm:pi-observational-memory": {
    expectedTools: ["recall"],
    expectedCommands: ["om:status", "om:view"],
    safeSmoke: "static only; recall requires a specific observation id",
    risk: "low",
  },
  "npm:pi-until-done": {
    expectedTools: [
      "until_done_plan",
      "until_done_replan",
      "until_done_task_update",
      "until_done_set",
      "until_done_complete",
      "until_done_block",
      "until_done_progress",
      "until_done_distill",
    ],
    expectedCommands: ["until-done"],
    expectedFlags: ["until-done"],
    safeSmoke: "static only; autonomous loop requires dedicated sandbox smoke",
    risk: "medium",
  },
  "npm:@ff-labs/pi-fff": {
    expectedTools: ["ffgrep", "fffind", "fff-multi-grep"],
    optionalToolAliases: ["grep", "find", "multi_grep"],
    expectedCommands: ["fff-mode", "fff-health", "fff-rescan"],
    expectedFlags: ["fff-mode", "fff-frecency-db", "fff-history-db", "fff-enable-root-scan"],
    safeSmoke: "candidate for low-risk fffind/ffgrep smoke",
    risk: "low",
  },
  "npm:pi-web-access": {
    expectedTools: ["web_search", "fetch_content", "get_search_content"],
    expectedCommands: ["websearch", "curator", "google-account", "search"],
    safeSmoke: "static only; external search/fetch behavior depends on providers/network",
    risk: "medium",
  },
  "npm:pi-smart-fetch": {
    expectedTools: ["web_fetch", "batch_web_fetch"],
    safeSmoke: "web_fetch covered by xtalpi live smoke; batch_web_fetch still targeted-only",
    risk: "low",
  },
  "npm:@juicesharp/rpiv-advisor": {
    expectedTools: ["advisor"],
    expectedCommands: ["advisor"],
    safeSmoke: "static only; forwards conversation to configured advisor model",
    risk: "medium",
  },
  "npm:pi-simplify": {
    expectedCommands: ["simplify"],
    safeSmoke: "command-only; not directly model-callable",
    risk: "low",
  },
  "npm:@narumitw/pi-plan-mode": {
    expectedTools: ["plan_mode_question"],
    expectedCommands: ["plan"],
    expectedFlags: ["plan"],
    safeSmoke: "static only; tool is only usable while Plan mode is active and UI is present",
    risk: "medium",
  },
  "npm:@feniix/pi-sequential-thinking": {
    expectedTools: [
      "process_thought",
      "generate_summary",
      "clear_history",
      "export_session",
      "import_session",
      "get_thinking_history",
      "get_thinking_status",
      "sequential_think",
    ],
    expectedFlags: [
      "--seq-think-storage-dir",
      "--seq-think-config-file",
      "--seq-think-config",
      "--seq-think-max-bytes",
      "--seq-think-max-lines",
    ],
    safeSmoke: "candidate for isolated get_thinking_status smoke",
    risk: "low",
  },
  "git:github.com/justhil/pi-image-gen": {
    expectedTools: ["image_gen", "image_review"],
    expectedCommands: ["image-gen"],
    safeSmoke: "static only; requires image provider config/artifacts",
    risk: "medium",
  },
  "npm:@narumitw/pi-btw": {
    expectedCommands: ["btw"],
    safeSmoke: "command-only; not directly model-callable",
    risk: "low",
  },
  "git:github.com/arpagon/pi-rewind": {
    expectedCommands: ["rewind"],
    expectedShortcuts: ["escape escape"],
    safeSmoke: "command/shortcut only; checkpoint restore needs manual scenario",
    risk: "low",
  },
  "npm:pi-mcp-adapter": {
    expectedTools: ["mcp"],
    dynamicTools: true,
    expectedCommands: ["mcp", "mcp-auth"],
    expectedFlags: ["mcp-config"],
    safeSmoke: "static only; direct MCP tools depend on mcp.json, metadata cache, env, and auth",
    risk: "medium",
  },
  "npm:pi-markdown-preview": {
    expectedTools: ["preview_export"],
    expectedCommands: ["preview", "preview-browser", "preview-pdf", "preview-clear-cache"],
    safeSmoke: "static only; preview/export should write isolated artifacts in smoke",
    risk: "medium",
  },
  "npm:@juicesharp/rpiv-ask-user-question": {
    expectedTools: ["ask_user_question"],
    safeSmoke: "static only; requires interactive UI/user response",
    risk: "medium",
  },
  "npm:@victor-software-house/pi-curated-themes": {
    safeSmoke: "theme package; no model-callable tool expected",
    risk: "low",
    notes: ["installed theme surface, not an xtalpi tool-calling target"],
  },
};

const TARGET_ALIASES = {
  "pi-subagents": "npm:pi-subagents",
  "pi-observational-memory": "npm:pi-observational-memory",
  "pi-until-done": "npm:pi-until-done",
  "@ff-labs/pi-fff": "npm:@ff-labs/pi-fff",
  "pi-web-access": "npm:pi-web-access",
  "pi-smart-fetch": "npm:pi-smart-fetch",
  "@juicesharp/rpiv-advisor": "npm:@juicesharp/rpiv-advisor",
  "pi-simplify": "npm:pi-simplify",
  "@narumitw/pi-plan-mode": "npm:@narumitw/pi-plan-mode",
  "@feniix/pi-sequential-thinking": "npm:@feniix/pi-sequential-thinking",
  "justhil/pi-image-gen": "git:github.com/justhil/pi-image-gen",
  "pi-image-gen": "git:github.com/justhil/pi-image-gen",
  "@narumitw/pi-btw": "npm:@narumitw/pi-btw",
  "arpagon/pi-rewind": "git:github.com/arpagon/pi-rewind",
  "pi-rewind": "git:github.com/arpagon/pi-rewind",
  "pi-mcp-adapter": "npm:pi-mcp-adapter",
  "pi-markdown-preview": "npm:pi-markdown-preview",
  "@juicesharp/rpiv-ask-user-question": "npm:@juicesharp/rpiv-ask-user-question",
  "pi-rules-loader": "npm:pi-rules-loader",
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function displayPath(value) {
  if (!value) return value;
  const home = os.homedir();
  return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function normalizeSpec(target) {
  if (!target) return target;
  if (target.startsWith("npm:") || target.startsWith("git:") || target.startsWith("local:")) return target;
  const clean = target.replace(/:.+$/, "");
  return TARGET_ALIASES[clean] || `npm:${clean}`;
}

function specToDir(spec) {
  if (spec.startsWith("npm:")) return path.join(agentDir, "npm", "node_modules", spec.slice("npm:".length));
  if (spec.startsWith("git:github.com/")) return path.join(agentDir, "git", "github.com", spec.slice("git:github.com/".length));
  if (spec.startsWith("local:")) return path.resolve(agentDir, spec.slice("local:".length));
  return path.join(agentDir, "npm", "node_modules", spec);
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function literalCalls(files, method) {
  const values = [];
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*(?:<[^>]+>)?\\s*\\(\\s*["']([^"']+)["']`, "g");
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(pattern)) values.push(match[1]);
  }
  return unique(values);
}

function objectNameLiterals(files) {
  const values = [];
  const pattern = /name\s*:\s*["']([A-Za-z0-9_:-]+)["']/g;
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(pattern)) values.push(match[1]);
  }
  return unique(values);
}

function hooks(files) {
  return literalCalls(files, "pi.on");
}

function findEvidence(root, names) {
  const files = walkFiles(root);
  const evidence = [];
  for (const name of names) {
    for (const file of files) {
      let lines = [];
      try {
        lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      } catch {
        continue;
      }
      const index = lines.findIndex((line) => line.includes(name));
      if (index !== -1) {
        evidence.push({
          name,
          file: displayPath(path.relative(root, file)),
          line: index + 1,
        });
        break;
      }
    }
  }
  return evidence;
}

function missingExpected(expected, actual) {
  const actualSet = new Set(actual);
  return expected.filter((item) => !actualSet.has(item));
}

function packageEntry(spec, source) {
  const root = specToDir(spec);
  const installed = fs.existsSync(root);
  const known = KNOWN[spec] || {};
  if (!installed) {
    return {
      spec,
      source,
      installed: false,
      root: displayPath(root),
      packageName: spec.replace(/^npm:/, "").replace(/^git:github\.com\//, ""),
      version: null,
      modelCallableTools: [],
      commands: [],
      flags: [],
      shortcuts: [],
      hooks: [],
      optionalToolAliases: known.optionalToolAliases || [],
      dynamicTools: Boolean(known.dynamicTools),
      surface: "missing",
      risk: known.risk || "unknown",
      safeSmoke: known.safeSmoke || "not available",
      notes: known.notes || [],
      evidence: [],
      missingExpected: {
        tools: known.expectedTools || [],
        commands: known.expectedCommands || [],
        flags: known.expectedFlags || [],
        shortcuts: known.expectedShortcuts || [],
      },
    };
  }

  let pkg = {};
  try {
    pkg = readJson(path.join(root, "package.json"));
  } catch {
    pkg = {};
  }
  const files = walkFiles(root);
  const literalToolNames = literalCalls(files, "pi.registerTool");
  const literalCommands = literalCalls(files, "pi.registerCommand");
  const literalFlags = literalCalls(files, "pi.registerFlag");
  const literalShortcuts = literalCalls(files, "pi.registerShortcut");
  const objectNames = objectNameLiterals(files);

  const tools = unique([
    ...literalToolNames,
    ...(known.expectedTools || []).filter((name) => objectNames.includes(name) || findEvidence(root, [name]).length > 0),
  ]);
  const commands = unique([...literalCommands, ...(known.expectedCommands || []).filter((name) => findEvidence(root, [name]).length > 0)]);
  const flags = unique([...literalFlags, ...(known.expectedFlags || []).filter((name) => findEvidence(root, [name]).length > 0)]);
  const shortcuts = unique([
    ...literalShortcuts,
    ...(known.expectedShortcuts || []).filter((name) => findEvidence(root, [name]).length > 0),
  ]);
  const hookNames = hooks(files);

  let surface = "command_or_hook_only";
  if (tools.length > 0) surface = "model_callable";
  if (!tools.length && !commands.length && !flags.length && !shortcuts.length && !hookNames.length) surface = "package_only";

  const expectedTools = known.expectedTools || [];
  const evidence = findEvidence(root, unique([
    ...tools,
    ...commands,
    ...flags,
    ...shortcuts,
    ...(known.optionalToolAliases || []),
  ]));

  return {
    spec,
    source,
    installed,
    root: displayPath(root),
    packageName: pkg.name || spec.replace(/^npm:/, "").replace(/^git:github\.com\//, ""),
    version: pkg.version || null,
    modelCallableTools: tools,
    commands,
    flags,
    shortcuts,
    hooks: hookNames,
    optionalToolAliases: known.optionalToolAliases || [],
    dynamicTools: Boolean(known.dynamicTools),
    surface,
    risk: known.risk || "unknown",
    safeSmoke: known.safeSmoke || "static only",
    notes: [
      ...(known.notes || []),
      ...(known.dynamicTools ? ["direct tool names are runtime-dependent"] : []),
    ],
    evidence,
    missingExpected: {
      tools: missingExpected(expectedTools, tools),
      commands: missingExpected(known.expectedCommands || [], commands),
      flags: missingExpected(known.expectedFlags || [], flags),
      shortcuts: missingExpected(known.expectedShortcuts || [], shortcuts),
    },
  };
}

const settingsFile = path.join(repoRoot, "settings.json");
const settings = readJson(settingsFile);
const settingsSpecs = Array.isArray(settings.packages) ? settings.packages.map(String) : [];
const requestedSpecs = includeTargets.map(normalizeSpec);
const specs = unique([...settingsSpecs, ...requestedSpecs]);
const entries = specs.map((spec) => packageEntry(spec, settingsSpecs.includes(spec) ? "settings" : "included"));

const summary = {
  total: entries.length,
  installed: entries.filter((entry) => entry.installed).length,
  missing: entries.filter((entry) => !entry.installed).length,
  modelCallablePackages: entries.filter((entry) => entry.surface === "model_callable").length,
  commandOrHookOnlyPackages: entries.filter((entry) => entry.surface === "command_or_hook_only").length,
  packageOnlyPackages: entries.filter((entry) => entry.surface === "package_only").length,
  dynamicToolPackages: entries.filter((entry) => entry.dynamicTools).length,
  packagesWithMissingExpectedEvidence: entries.filter((entry) =>
    Object.values(entry.missingExpected).some((items) => items.length > 0),
  ).length,
};

const report = {
  schemaVersion: 1,
  schemaId: "pi67-xtalpi-tool-coverage-audit/v1",
  generatedAt: new Date().toISOString(),
  repository: displayPath(repoRoot),
  agentDir: displayPath(agentDir),
  settings: displayPath(settingsFile),
  summary,
  entries,
};

function renderList(items) {
  return items.length ? items.join(", ") : "-";
}

function renderText() {
  const lines = [];
  lines.push("pi67 xtalpi tool coverage audit");
  lines.push(`repository: ${report.repository}`);
  lines.push(`agent_dir: ${report.agentDir}`);
  lines.push(
    `summary: total=${summary.total} installed=${summary.installed} missing=${summary.missing} model_callable_packages=${summary.modelCallablePackages} command_or_hook_only=${summary.commandOrHookOnlyPackages} dynamic_tool_packages=${summary.dynamicToolPackages} missing_expected_evidence=${summary.packagesWithMissingExpectedEvidence}`,
  );
  lines.push("");
  for (const entry of entries) {
    lines.push(`- ${entry.spec}`);
    lines.push(`  installed: ${entry.installed ? "yes" : "no"} (${entry.root})`);
    lines.push(`  package: ${entry.packageName}${entry.version ? `@${entry.version}` : ""}`);
    lines.push(`  surface: ${entry.surface}${entry.dynamicTools ? " + dynamic" : ""}`);
    lines.push(`  tools: ${renderList(entry.modelCallableTools)}`);
    if (entry.optionalToolAliases.length) lines.push(`  optional_tool_aliases: ${renderList(entry.optionalToolAliases)}`);
    lines.push(`  commands: ${renderList(entry.commands)}`);
    lines.push(`  flags: ${renderList(entry.flags)}`);
    lines.push(`  shortcuts: ${renderList(entry.shortcuts)}`);
    lines.push(`  hooks: ${renderList(entry.hooks)}`);
    lines.push(`  risk: ${entry.risk}`);
    lines.push(`  smoke: ${entry.safeSmoke}`);
    const missing = Object.entries(entry.missingExpected)
      .filter(([, items]) => items.length)
      .map(([key, items]) => `${key}=${items.join(",")}`);
    if (missing.length) lines.push(`  missing_expected_evidence: ${missing.join("; ")}`);
    for (const note of entry.notes) lines.push(`  note: ${note}`);
  }
  lines.push("");
  lines.push("Note: installed packages become callable by xtalpi-pi-tools only when Pi registers them into context.tools for the current turn and the selected-tool whitelist exposes them to the model.");
  return `${lines.join("\n")}\n`;
}

if (outputFormat === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderText());
}
NODE

if [ -n "$OUTPUT" ]; then
  mv "$TMP_OUTPUT" "$OUTPUT"
fi
