#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const REQUIRED_RULES = [
  "architecture-quality.md",
  "browser.md",
  "commerce-growth.md",
  "context-budget.md",
  "data-quality.md",
  "frontend.md",
  "investment.md",
  "performance.md",
  "pi67-product-boundary.md",
  "project-structure.md",
  "quality.md",
];
const REQUIRED_PROMPTS = ["debug.md", "deliver.md", "frontend-kickoff.md", "review.md", "scoped-commit.md"];
const MAX_PROJECTED_RULE_INDEX_CHARS = 3400;

function parseArgs(argv) {
  const options = { repoRoot: DEFAULT_REPO_ROOT, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") options.repoRoot = path.resolve(argv[++index] || "");
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  process.stdout.write(`pi67-prompt-governance-check.mjs

Usage:
  node scripts/pi67-prompt-governance-check.mjs [--repo-root PATH] [--json]
`);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function markdownMetadata(text) {
  return {
    title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || "",
    description: text.match(/^---[\s\S]*?\ndescription:\s*(.+?)\s*\n[\s\S]*?---/m)?.[1]?.trim() || "",
    triggers: text.match(/^---[\s\S]*?\ntriggers:\s*(.+?)\s*\n[\s\S]*?---/m)?.[1]?.trim() || "",
    argumentHint: text.match(/^---[\s\S]*?\nargument-hint:\s*(.+?)\s*\n[\s\S]*?---/m)?.[1]?.trim() || "",
  };
}

function projectedRulesIndexChars(repoRoot, ruleFiles) {
  const lines = ruleFiles.map((name) => {
    const absolutePath = path.join(repoRoot, "rules", name);
    const metadata = markdownMetadata(readText(absolutePath));
    return `- [global] ${absolutePath} - ${metadata.title}: ${metadata.description}`;
  });
  const text = `

## Pi Rules Loader

Detailed rules are indexed below but are not automatically loaded in full. For L1/L2 work, use the global/project AGENTS routing contract and read only the minimum relevant files before planning or editing.

### Available Rule Files

${lines.join("\n")}

### Rule Use Contract

- Do not read every rule by default; read only the smallest relevant set.
- If rule files cannot be read, say so and proceed with the global AGENTS kernel plus project context.
- In final delivery for non-trivial work, briefly mention the key rules used.
`;
  return text.length;
}

function analyze(repoRoot) {
  const checks = [];
  const add = (name, ok, message) => checks.push({ name, ok: Boolean(ok), message });
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const agents = readText(agentsPath).replace(/\r\n?/gu, "\n");
  const agentsLines = agents ? agents.split("\n").length - 1 : 0;
  const agentsChars = agents.length;
  const kernelVersion = agents.match(/^> Version: `([^`]+)`$/m)?.[1] || "";

  add("agents.exists", Boolean(agents), "AGENTS.md exists and is readable");
  add("agents.version", Boolean(kernelVersion), `AGENTS.md kernel version=${kernelVersion || "missing"}`);
  add("agents.short-kernel-lines", agentsLines > 0 && agentsLines <= 140, `AGENTS.md lines=${agentsLines}, limit=140`);
  add("agents.short-kernel-chars", agentsChars > 0 && agentsChars <= 4500, `AGENTS.md chars=${agentsChars}, limit=4500`);
  add("agents.live-capabilities", /live tool list/.test(agents), "capability routing is conditioned on the live tool list");
  add(
    "agents.memory-tools",
    /`briefing`\s*\/\s*`recall`/.test(agents) && !/agent_memory_(briefing|recall)/.test(agents),
    "memory routing uses current short direct-tool names without stale prefixes",
  );
  add(
    "agents.git-safety",
    /git status --short/.test(agents) && /git add -A/.test(agents) && /force push/.test(agents),
    "scoped Git and history-rewrite boundaries remain in the kernel",
  );
  add(
    "agents.system-ownership",
    /SYSTEM\.md/.test(agents) && /替换 upstream 默认 system prompt/.test(agents),
    "the kernel documents upstream system-prompt ownership",
  );
  add(
    "agents.pi67-routing",
    /rules\/pi67-product-boundary\.md/.test(agents) && /pi67-product-boundary\.md/.test(agents),
    "pi-67 product details route to the on-demand rule",
  );
  add(
    "agents.runtime-entrypoint-boundary",
    [
      "唯一 Pi 运行时、Harness 和 agent loop 权威",
      "`pi` TUI 与 Pi-67 Desktop 都是第一方用户入口",
      "Pi JSONL Session",
      "不并发写同一 Session",
    ].every((value) => agents.includes(value)),
    "the kernel separates Pi runtime authority from TUI/Desktop entrypoints and concurrent Session ownership",
  );
  add(
    "agents.authorization-layers",
    ["回答/评审/诊断/规划", "修改/构建/修复", "scoped add / scoped commit", "不等于 push", "必须有当前明确授权"]
      .every((value) => agents.includes(value)),
    "read-only, modification, commit, and external-action authorization layers remain distinct",
  );
  add(
    "agents.conditional-delivery",
    /仅在实际相关时说明/.test(agents),
    "delivery avoids irrelevant structure, browser, and performance boilerplate",
  );
  add(
    "agents.native-image-routing",
    [
      "图片生成或编辑",
      "图片理解、截图分析、OCR",
      "当前模型原生多模态",
      "模型声明与真实传输不一致",
      "显式可观察 fallback",
      "不静默切换模型或 provider",
    ].every((value) => agents.includes(value)),
    "native multimodal image understanding is separated from generation and uses only explicit observable fallback",
  );

  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
    add(`system.${name}.absent`, !fs.existsSync(path.join(repoRoot, name)), `${name} does not replace or append to upstream defaults`);
  }

  const rulesDir = path.join(repoRoot, "rules");
  const ruleFiles = fs.existsSync(rulesDir)
    ? fs.readdirSync(rulesDir).filter((name) => name.endsWith(".md")).sort()
    : [];
  for (const name of REQUIRED_RULES) {
    const text = readText(path.join(rulesDir, name));
    const metadata = markdownMetadata(text);
    add(`rule.${name}`, Boolean(text && metadata.title && metadata.description && metadata.triggers), `${name} has title and routing metadata`);
  }
  add(
    "rules.expected-set",
    REQUIRED_RULES.every((name) => ruleFiles.includes(name)),
    `required rules=${REQUIRED_RULES.length}, discovered rules=${ruleFiles.length}`,
  );

  const productRule = readText(path.join(rulesDir, "pi67-product-boundary.md"));
  const browserRule = readText(path.join(rulesDir, "browser.md"));
  add(
    "rules.browser-search-instance-contract",
    [
      "`web_search` / `fetch_content`",
      "Provider-native Search",
      "browser_instance_ops list",
      "browser_instance_id",
      "AMBIGUOUS_TARGET",
      "BROWSER_INSTANCE_UNAVAILABLE",
      "Cross-instance cleanup",
    ].every((value) => browserRule.includes(value))
      && !/Use `pi-web-access`/.test(browserRule)
      && !/Use `pi-smart-fetch`/.test(browserRule),
    "browser rule uses current Search routing and explicit fail-closed Browser Instance lifecycle",
  );
  add(
    "rules.pi67-boundary-contract",
    [
      "upstream",
      "pi-67",
      "Pi-67 Desktop",
      "first-party Electron client and Pi harness",
      "supported Pi SDK",
      "Pi JSONL",
      "xtalpi-pi-tools",
      "/login",
      "/model",
    ].every((value) => productRule.includes(value))
      && !/daily user entrypoint is always `pi`/.test(productRule),
    "pi-67 ownership rule preserves runtime, TUI/Desktop entrypoint, provider, and acceptance boundaries",
  );

  const investmentRule = readText(path.join(rulesDir, "investment.md"));
  let skillPackRegistry = {};
  try {
    skillPackRegistry = JSON.parse(readText(path.join(repoRoot, "shared-skill-packs.json")));
  } catch {
    skillPackRegistry = {};
  }
  const investmentPack = skillPackRegistry.packs?.find((pack) => pack?.name === "ai-berkshire-investment-suite");
  const investmentSkills = Array.isArray(investmentPack?.skills) ? investmentPack.skills : [];
  const uncoveredInvestmentSkills = investmentSkills.filter((name) => !investmentRule.includes(`\`${name}\``));
  add(
    "rules.investment-pack-coverage",
    investmentSkills.length === 21 && uncoveredInvestmentSkills.length === 0,
    `AI Berkshire Skills=${investmentSkills.length}, uncovered=${uncoveredInvestmentSkills.join(",") || "none"}`,
  );
  add(
    "rules.investment-gates",
    ["OUTSIDE_AI_BERKSHIRE_SCOPE", "date", "two independent sources", "financial_rigor.py", "report_audit.py", "Markdown", "degraded execution"]
      .every((value) => investmentRule.includes(value)),
    "investment rule preserves scope, currentness, dual-source, exact-calculation, audit, source-of-truth, and team-truthfulness gates",
  );

  const promptsDir = path.join(repoRoot, "prompts");
  const promptFiles = fs.existsSync(promptsDir)
    ? fs.readdirSync(promptsDir).filter((name) => name.endsWith(".md")).sort()
    : [];
  for (const name of REQUIRED_PROMPTS) {
    const text = readText(path.join(promptsDir, name));
    const metadata = markdownMetadata(text);
    add(`prompt.${name}`, Boolean(text && metadata.description && metadata.argumentHint), `${name} has prompt metadata`);
  }
  add(
    "prompts.expected-set",
    REQUIRED_PROMPTS.every((name) => promptFiles.includes(name)),
    `required prompts=${REQUIRED_PROMPTS.length}, discovered prompts=${promptFiles.length}`,
  );

  const rulesLoaderPath = path.join(repoRoot, "extensions", "pi-rules-loader", "index.ts");
  const rulesLoader = readText(rulesLoaderPath);
  const visionBridgePath = path.join(repoRoot, "extensions", "pi-vision-bridge", "index.ts");
  const visionBridge = readText(visionBridgePath);
  add("vision-bridge.exists", Boolean(visionBridge), "pi-vision-bridge source exists");
  add(
    "vision-bridge.fallback-only",
    [
      "仅当当前模型或 provider 无法原生接收图片时",
      "原生多模态模型应直接接收图片",
      "text-only provider",
    ].every((value) => visionBridge.includes(value))
      && !visionBridge.includes("图片任务优先调用它")
      && !visionBridge.includes("优先调用 vision_read"),
    "vision_read no longer overrides native multimodal image routing",
  );
  const projectedIndexChars = projectedRulesIndexChars(repoRoot, ruleFiles);
  add("rules-loader.exists", Boolean(rulesLoader), "pi-rules-loader source exists");
  add(
    "rules-loader.no-duplicate-digest",
    Boolean(rulesLoader) && !/KERNEL_DIGEST|Rules Kernel Digest/.test(rulesLoader),
    "pi-rules-loader does not duplicate the AGENTS routing matrix",
  );
  add(
    "rules-loader.compact-paths",
    Boolean(rulesLoader) && !/displayPath/.test(rulesLoader),
    "the injected index emits one executable path per rule",
  );
  add(
    "rules-loader.trigger-routing",
    ["triggersFromFrontmatter", "matchedRulesForPrompt", "event.prompt", "BEGIN ACTIVE RULE"].every((value) => rulesLoader.includes(value)),
    "pi-rules-loader parses triggers and injects directly matched rule bodies",
  );
  add(
    "rules-loader.contextual-state",
    ["ACTIVE_RULE_STATE_TYPE", "activeRulePaths", "isContextualFollowUp", "appendEntry"].every((value) => rulesLoader.includes(value)),
    "pi-rules-loader persists and restores contextual active-rule state",
  );
  add(
    "rules-loader.projected-size",
    projectedIndexChars > 0 && projectedIndexChars <= MAX_PROJECTED_RULE_INDEX_CHARS,
    `projected rules index chars=${projectedIndexChars}, limit=${MAX_PROJECTED_RULE_INDEX_CHARS}`,
  );

  const readme = readText(path.join(repoRoot, "README.md"));
  const fullInstall = readText(path.join(repoRoot, "docs", "full-install.md"));
  const releaseDoc = readText(path.join(repoRoot, "docs", "release.md"));
  add("docs.kernel-version", Boolean(kernelVersion && readme.includes(kernelVersion)), "README documents the current AGENTS kernel version");
  add(
    "docs.rule-count",
    readme.includes(`\`rules/\` (${ruleFiles.length} 篇)`) && fullInstall.includes(`${ruleFiles.length} rule files`),
    `README and full-install document ${ruleFiles.length} rules`,
  );
  add(
    "docs.release-command",
    /node scripts\/pi67-prompt-governance-check\.mjs/.test(releaseDoc),
    "release documentation exposes the standalone prompt-governance command",
  );

  let packageJson = {};
  try {
    packageJson = JSON.parse(readText(path.join(repoRoot, "package.json")));
  } catch {
    packageJson = {};
  }
  add(
    "integration.npm-script",
    packageJson.scripts?.["check:prompt-governance"] === "node scripts/pi67-prompt-governance-check.mjs",
    "package.json exposes the stable prompt-governance lifecycle command",
  );
  const releaseCheck = readText(path.join(repoRoot, "scripts", "pi67-release-check.sh"));
  const smokeSh = readText(path.join(repoRoot, "scripts", "pi67-smoke.sh"));
  const smokePs1 = readText(path.join(repoRoot, "scripts", "pi67-smoke.ps1"));
  add(
    "integration.release-smoke",
    [releaseCheck, smokeSh, smokePs1].every((text) => text.includes("pi67-prompt-governance-check.mjs")),
    "release and Bash/PowerShell smoke gates invoke prompt governance",
  );

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  return {
    schema: "pi67.prompt-governance.v1",
    repoRoot,
    metrics: {
      agentsLines,
      agentsChars,
      kernelVersion,
      agentsPiHeuristicTokens: Math.ceil(agentsChars / 4),
      rules: ruleFiles.length,
      promptTemplates: promptFiles.length,
      projectedRulesIndexChars: projectedIndexChars,
      projectedRulesIndexPiHeuristicTokens: Math.ceil(projectedIndexChars / 4),
    },
    checks,
    summary: { passed, failed, ok: failed === 0 },
  };
}

function renderText(result) {
  const lines = [
    "pi-67 prompt governance",
    `Repository: ${result.repoRoot}`,
    `AGENTS: lines=${result.metrics.agentsLines} chars=${result.metrics.agentsChars} heuristic_tokens=${result.metrics.agentsPiHeuristicTokens}`,
    `Rules: count=${result.metrics.rules} projected_index_chars=${result.metrics.projectedRulesIndexChars} heuristic_tokens=${result.metrics.projectedRulesIndexPiHeuristicTokens}`,
    `Prompts: count=${result.metrics.promptTemplates}`,
    "",
  ];
  for (const check of result.checks) lines.push(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`);
  lines.push("");
  lines.push(`Summary: PASS ${result.summary.passed} / FAIL ${result.summary.failed}`);
  lines.push(`Result: ${result.summary.ok ? "PASS" : "FAIL"}`);
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const result = analyze(options.repoRoot);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
  if (!result.summary.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`pi-67 prompt governance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
