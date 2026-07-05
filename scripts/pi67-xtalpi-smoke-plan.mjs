#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_AGENT_DIR = process.env.PI_AGENT_DIR || DEFAULT_REPO_ROOT;

const WINDOWS_TARGETED_CASES = [
  { caseName: "fffind-package", tools: ["fffind"], profile: "extension-expanded" },
  { caseName: "ffgrep-package", tools: ["ffgrep"], profile: "extension-expanded" },
  { caseName: "batch-web-fetch-example", tools: ["batch_web_fetch"], profile: "extension-expanded" },
  { caseName: "seq-thinking-status", tools: ["get_thinking_status"], profile: "extension-expanded" },
  { caseName: "mcp-status", tools: ["mcp"], profile: "extension-low-risk" },
  { caseName: "subagent-list", tools: ["subagent"], profile: "extension-low-risk" },
  { caseName: "recall-not-found", tools: ["recall"], profile: "extension-low-risk" },
];

const BASH_TARGETED_CASES = [
  { caseName: "read", tools: ["read"], profile: "full-suite" },
  { caseName: "web-read", tools: ["web_fetch", "read"], profile: "full-suite" },
  ...WINDOWS_TARGETED_CASES,
];

const KNOWN = {
  "npm:pi-subagents": {
    expectedTools: ["subagent"],
    expectedCommands: ["subagent"],
    risk: "medium",
    smokePolicy: "windows_targeted_read_only",
    safeSmoke: "covered by subagent-list; write/execution actions require separate scoped smoke",
  },
  "npm:pi-observational-memory": {
    expectedTools: ["recall"],
    expectedCommands: ["om:status", "om:view"],
    risk: "low",
    smokePolicy: "windows_targeted_read_only",
    safeSmoke: "covered by recall-not-found with sentinel id deadbeef0000",
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
    risk: "medium",
    smokePolicy: "manual_sandbox",
    safeSmoke: "autonomous loop/state mutation requires a dedicated sandbox smoke",
  },
  "npm:@ff-labs/pi-fff": {
    expectedTools: ["ffgrep", "fffind", "fff-multi-grep"],
    optionalToolAliases: ["grep", "find", "multi_grep"],
    expectedCommands: ["fff-mode", "fff-health", "fff-rescan"],
    risk: "low",
    smokePolicy: "partially_windows_targeted",
    safeSmoke: "fffind and ffgrep are covered by extension-expanded; fff-multi-grep remains manual/static",
  },
  "npm:pi-web-access": {
    expectedTools: ["web_search", "fetch_content", "get_search_content"],
    expectedCommands: ["websearch", "curator", "google-account", "search"],
    risk: "medium",
    smokePolicy: "manual_network",
    safeSmoke: "external search/fetch behavior depends on provider config, network, and account state",
  },
  "npm:pi-smart-fetch": {
    expectedTools: ["web_fetch", "batch_web_fetch"],
    risk: "low",
    smokePolicy: "partially_windows_targeted",
    safeSmoke: "batch_web_fetch is covered by extension-expanded; web_fetch is covered by Bash full-suite web-read",
  },
  "npm:@juicesharp/rpiv-advisor": {
    expectedTools: ["advisor"],
    expectedCommands: ["advisor"],
    risk: "medium",
    smokePolicy: "manual_model_forwarding",
    safeSmoke: "forwards conversation to configured advisor model; keep out of low-risk default smoke",
  },
  "npm:pi-simplify": {
    expectedCommands: ["simplify"],
    risk: "low",
    smokePolicy: "not_model_callable",
    safeSmoke: "command-only; not directly model-callable by xtalpi-pi-tools",
  },
  "npm:@narumitw/pi-plan-mode": {
    expectedTools: ["plan_mode_question"],
    expectedCommands: ["plan"],
    risk: "medium",
    smokePolicy: "manual_interactive",
    safeSmoke: "tool is only usable while Plan mode and UI interaction are active",
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
    risk: "low",
    smokePolicy: "partially_windows_targeted",
    safeSmoke: "get_thinking_status is covered with isolated MCP_STORAGE_DIR; mutating tools require separate sandbox smoke",
  },
  "git:github.com/justhil/pi-image-gen": {
    expectedTools: ["image_gen", "image_review"],
    expectedCommands: ["image-gen"],
    risk: "medium",
    smokePolicy: "manual_artifact",
    safeSmoke: "image generation/review requires provider config, cost/artifacts, and output inspection",
  },
  "npm:@narumitw/pi-btw": {
    expectedCommands: ["btw"],
    risk: "low",
    smokePolicy: "not_model_callable",
    safeSmoke: "command-only; not directly model-callable by xtalpi-pi-tools",
  },
  "git:github.com/arpagon/pi-rewind": {
    expectedCommands: ["rewind"],
    expectedShortcuts: ["escape escape"],
    risk: "low",
    smokePolicy: "not_model_callable",
    safeSmoke: "command/shortcut only; checkpoint restore needs a manual scenario",
  },
  "npm:pi-mcp-adapter": {
    expectedTools: ["mcp"],
    expectedCommands: ["mcp", "mcp-auth"],
    dynamicTools: true,
    risk: "medium",
    smokePolicy: "gateway_windows_targeted",
    safeSmoke: "mcp gateway/status is covered; direct MCP tools depend on mcp.json/cache/env/auth",
  },
  "npm:pi-markdown-preview": {
    expectedTools: ["preview_export"],
    expectedCommands: ["preview", "preview-browser", "preview-pdf", "preview-clear-cache"],
    risk: "medium",
    smokePolicy: "manual_artifact",
    safeSmoke: "preview/export writes artifacts; use isolated output and inspect file paths",
  },
  "npm:@juicesharp/rpiv-ask-user-question": {
    expectedTools: ["ask_user_question"],
    risk: "medium",
    smokePolicy: "manual_interactive",
    safeSmoke: "requires interactive UI/user response; not suitable for unattended smoke",
  },
  "npm:@victor-software-house/pi-curated-themes": {
    risk: "low",
    smokePolicy: "not_model_callable",
    safeSmoke: "theme package; no model-callable tool expected",
  },
  "local:extensions/pi-rules-loader": {
    packageName: "pi-rules-loader",
    risk: "low",
    smokePolicy: "not_model_callable",
    safeSmoke: "hook-only rules index injection; not directly model-callable",
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
  "pi-rules-loader": "local:extensions/pi-rules-loader",
};

function usage() {
  console.log(`Usage:
  pi67-xtalpi-smoke-plan.mjs [options]

Options:
  --repo-root DIR    pi-67 checkout. Defaults to parent of this script.
  --agent-dir DIR    Pi agent dir/package root. Defaults to PI_AGENT_DIR or repo root.
  --include TARGET   Include an extra package/tool target. Repeatable.
  --json             Emit machine-readable JSON.
  -h, --help         Show this help.

Examples:
  node scripts/pi67-xtalpi-smoke-plan.mjs
  node scripts/pi67-xtalpi-smoke-plan.mjs --json
  node scripts/pi67-xtalpi-smoke-plan.mjs --include pi-markdown-preview
`);
}

function parseArgs(argv) {
  const args = {
    repoRoot: DEFAULT_REPO_ROOT,
    agentDir: DEFAULT_AGENT_DIR,
    include: [],
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo-root":
        args.repoRoot = argv[++index] || "";
        break;
      case "--agent-dir":
        args.agentDir = argv[++index] || "";
        break;
      case "--include":
        args.include.push(argv[++index] || "");
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.repoRoot = path.resolve(args.repoRoot || DEFAULT_REPO_ROOT);
  args.agentDir = path.resolve(args.agentDir || args.repoRoot);
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
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

function specToDir(agentDir, spec) {
  if (spec.startsWith("npm:")) return path.join(agentDir, "npm", "node_modules", spec.slice("npm:".length));
  if (spec.startsWith("git:github.com/")) return path.join(agentDir, "git", "github.com", spec.slice("git:github.com/".length));
  if (spec.startsWith("local:")) return path.resolve(agentDir, spec.slice("local:".length));
  return path.join(agentDir, "npm", "node_modules", spec);
}

function fallbackPackageName(spec, known = {}) {
  if (known.packageName) return known.packageName;
  return spec.replace(/^npm:/, "").replace(/^git:github\.com\//, "").replace(/^local:/, "");
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

function evidenceExists(files, name) {
  for (const file of files) {
    try {
      if (fs.readFileSync(file, "utf8").includes(name)) return true;
    } catch {
      // ignore unreadable files in third-party packages
    }
  }
  return false;
}

function packageEntry(agentDir, spec, source) {
  const root = specToDir(agentDir, spec);
  const installed = fs.existsSync(root);
  const known = KNOWN[spec] || {};
  const base = {
    spec,
    source,
    installed,
    root: displayPath(root),
    packageName: fallbackPackageName(spec, known),
    version: null,
    modelCallableTools: [],
    commands: [],
    surface: installed ? "package_only" : "missing",
    dynamicTools: Boolean(known.dynamicTools),
    risk: known.risk || "unknown",
    smokePolicy: known.smokePolicy || "unknown",
    safeSmoke: known.safeSmoke || "no curated smoke policy yet",
    optionalToolAliases: known.optionalToolAliases || [],
  };
  if (!installed) return base;

  let pkg = {};
  try {
    pkg = readJson(path.join(root, "package.json"));
  } catch {
    pkg = {};
  }
  const files = walkFiles(root);
  const objectNames = objectNameLiterals(files);
  const tools = unique([
    ...literalCalls(files, "pi.registerTool"),
    ...(known.expectedTools || []).filter((name) => objectNames.includes(name) || evidenceExists(files, name)),
  ]);
  const commands = unique([
    ...literalCalls(files, "pi.registerCommand"),
    ...(known.expectedCommands || []).filter((name) => evidenceExists(files, name)),
  ]);
  let surface = "package_only";
  if (tools.length > 0) surface = "model_callable";
  else if (commands.length > 0 || (known.expectedShortcuts || []).some((name) => evidenceExists(files, name))) {
    surface = "command_or_hook_only";
  }
  return {
    ...base,
    packageName: pkg.name || base.packageName,
    version: pkg.version || null,
    modelCallableTools: tools,
    commands,
    surface,
  };
}

function toolCaseMap(cases) {
  const out = new Map();
  for (const item of cases) {
    for (const tool of item.tools) {
      if (!out.has(tool)) out.set(tool, []);
      out.get(tool).push(item);
    }
  }
  return out;
}

const WINDOWS_TOOL_CASES = toolCaseMap(WINDOWS_TARGETED_CASES);
const BASH_TOOL_CASES = toolCaseMap(BASH_TARGETED_CASES);

function planEntry(entry) {
  const windowsCoveredTools = entry.modelCallableTools.filter((tool) => WINDOWS_TOOL_CASES.has(tool));
  const bashCoveredTools = entry.modelCallableTools.filter((tool) => BASH_TOOL_CASES.has(tool));
  const uncoveredTools = entry.modelCallableTools.filter((tool) => !WINDOWS_TOOL_CASES.has(tool));
  const recommendedWindowsCases = unique(
    windowsCoveredTools.flatMap((tool) => WINDOWS_TOOL_CASES.get(tool).map((item) => item.caseName)),
  );
  const recommendedBashCases = unique(
    bashCoveredTools.flatMap((tool) => BASH_TOOL_CASES.get(tool).map((item) => item.caseName)),
  );

  let status = "not_model_callable";
  if (!entry.installed) {
    status = "missing_package";
  } else if (entry.modelCallableTools.length === 0) {
    status = "not_model_callable";
  } else if (uncoveredTools.length === 0) {
    status = "covered_by_windows_targeted_smoke";
  } else if (windowsCoveredTools.length > 0) {
    status = "partially_covered_by_windows_targeted_smoke";
  } else if (entry.dynamicTools) {
    status = "gateway_only_dynamic_tools_need_runtime_auth";
  } else {
    status = "manual_or_static_only";
  }

  const suggestedManualSmoke =
    uncoveredTools.length > 0
      ? `review tool schema and run a one-tool targeted smoke with --tools ${uncoveredTools[0]} in an isolated workspace`
      : "";

  return {
    spec: entry.spec,
    packageName: entry.packageName,
    installed: entry.installed,
    surface: entry.surface,
    risk: entry.risk,
    smokePolicy: entry.smokePolicy,
    status,
    modelCallableTools: entry.modelCallableTools,
    windowsCoveredTools,
    bashCoveredTools,
    uncoveredTools,
    recommendedWindowsCases,
    recommendedBashCases,
    suggestedManualSmoke,
    safeSmoke: entry.safeSmoke,
  };
}

function buildPlan(options) {
  const settingsFile = path.join(options.repoRoot, "settings.json");
  const settings = readJson(settingsFile);
  const settingsSpecs = Array.isArray(settings.packages) ? settings.packages.map(String) : [];
  const includeSpecs = options.include.map(normalizeSpec);
  const specs = unique([...settingsSpecs, "local:extensions/pi-rules-loader", ...includeSpecs]);
  const entries = specs.map((spec) => packageEntry(options.agentDir, spec, settingsSpecs.includes(spec) ? "settings" : "included"));
  const packagePlans = entries.map(planEntry);
  const summary = {
    packages: packagePlans.length,
    installed: packagePlans.filter((item) => item.installed).length,
    missing: packagePlans.filter((item) => !item.installed).length,
    modelCallablePackages: packagePlans.filter((item) => item.modelCallableTools.length > 0).length,
    windowsFullyCovered: packagePlans.filter((item) => item.status === "covered_by_windows_targeted_smoke").length,
    windowsPartiallyCovered: packagePlans.filter((item) => item.status === "partially_covered_by_windows_targeted_smoke").length,
    manualOrStatic: packagePlans.filter((item) =>
      ["manual_or_static_only", "gateway_only_dynamic_tools_need_runtime_auth", "not_model_callable"].includes(item.status),
    ).length,
    unknownPolicyPackages: packagePlans.filter((item) => item.smokePolicy === "unknown").length,
  };

  return {
    schemaVersion: 1,
    schemaId: "pi67-xtalpi-smoke-plan/v1",
    generatedAt: new Date().toISOString(),
    repository: displayPath(options.repoRoot),
    agentDir: displayPath(options.agentDir),
    settings: displayPath(settingsFile),
    summary,
    recommendedCommands: {
      windowsLowRisk:
        "powershell -ExecutionPolicy Bypass -File .\\scripts\\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk",
      windowsExpanded:
        "powershell -ExecutionPolicy Bypass -File .\\scripts\\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-expanded",
      bashFullSuite: "bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh --profile full-suite",
      smokePlan: "node ./scripts/pi67-xtalpi-smoke-plan.mjs",
    },
    windowsTargetedCases: WINDOWS_TARGETED_CASES,
    bashTargetedCases: BASH_TARGETED_CASES,
    packages: packagePlans,
    note:
      "A tool is callable by xtalpi-pi-tools only when Pi registers it into context.tools for the current turn and the selected-tool whitelist exposes it to the model. This plan is read-only and does not prove authenticated, mutating, interactive, or artifact-producing flows.",
  };
}

function renderList(items) {
  return items.length ? items.join(", ") : "-";
}

function renderText(plan) {
  const lines = [];
  lines.push("pi67 xtalpi smoke plan");
  lines.push(`repository: ${plan.repository}`);
  lines.push(`agent_dir: ${plan.agentDir}`);
  lines.push(
    `summary: packages=${plan.summary.packages} installed=${plan.summary.installed} missing=${plan.summary.missing} model_callable=${plan.summary.modelCallablePackages} windows_full=${plan.summary.windowsFullyCovered} windows_partial=${plan.summary.windowsPartiallyCovered} manual_or_static=${plan.summary.manualOrStatic} unknown_policy=${plan.summary.unknownPolicyPackages}`,
  );
  lines.push("");
  lines.push("recommended commands:");
  lines.push(`  windows low-risk : ${plan.recommendedCommands.windowsLowRisk}`);
  lines.push(`  windows expanded : ${plan.recommendedCommands.windowsExpanded}`);
  lines.push(`  bash full-suite  : ${plan.recommendedCommands.bashFullSuite}`);
  lines.push(`  refresh plan     : ${plan.recommendedCommands.smokePlan}`);
  lines.push("");
  for (const item of plan.packages) {
    lines.push(`- ${item.spec}`);
    lines.push(`  status: ${item.status}`);
    lines.push(`  package: ${item.packageName}`);
    lines.push(`  installed: ${item.installed ? "yes" : "no"}`);
    lines.push(`  surface: ${item.surface}`);
    lines.push(`  risk: ${item.risk}`);
    lines.push(`  tools: ${renderList(item.modelCallableTools)}`);
    lines.push(`  windows_covered_tools: ${renderList(item.windowsCoveredTools)}`);
    lines.push(`  uncovered_tools: ${renderList(item.uncoveredTools)}`);
    lines.push(`  windows_cases: ${renderList(item.recommendedWindowsCases)}`);
    if (item.suggestedManualSmoke) lines.push(`  manual_next: ${item.suggestedManualSmoke}`);
    lines.push(`  note: ${item.safeSmoke}`);
  }
  lines.push("");
  lines.push(`Note: ${plan.note}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const plan = buildPlan(options);
  process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : renderText(plan));
}

main().catch((error) => {
  console.error(`pi67 xtalpi smoke plan failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
