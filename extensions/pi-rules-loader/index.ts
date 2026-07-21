import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RuleSource = "global" | "project" | "agents" | "claude";

type RuleFile = {
  source: RuleSource;
  absolutePath: string;
  title: string;
  description: string;
  triggers: string[];
};

type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
};

type ActiveRuleState = {
  schema: typeof ACTIVE_RULE_STATE_SCHEMA;
  activeRulePaths: string[];
};

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? path.join(HOME, ".pi", "agent");
const GLOBAL_RULES_DIR = path.join(PI_AGENT_DIR, "rules");
const ACTIVE_RULE_STATE_TYPE = "pi-rules-loader.active-rules";
const ACTIVE_RULE_STATE_SCHEMA = "pi-rules-loader.active-rules/v1";
const MAX_ACTIVE_RULES = 3;

function safeReadIntro(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, 3000);
  } catch {
    return "";
  }
}

function frontmatterFor(text: string): string {
  return text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
}

function cleanTrigger(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
}

function triggersFromFrontmatter(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const triggerIndex = lines.findIndex((line) => /^triggers\s*:/i.test(line));
  if (triggerIndex < 0) return [];

  const firstLine = lines[triggerIndex] ?? "";
  const inlineValue = firstLine.replace(/^triggers\s*:\s*/i, "").trim();
  const values: string[] = [];

  if (inlineValue) {
    const unwrapped = inlineValue.replace(/^\[|\]$/g, "");
    values.push(...unwrapped.split(/[,，]/));
  } else {
    for (let index = triggerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const match = line.match(/^\s*-\s*(.+?)\s*$/);
      if (!match) break;
      values.push(match[1] ?? "");
    }
  }

  return [...new Set(values.map(cleanTrigger).filter(Boolean))];
}

function metadataFor(filePath: string): Pick<RuleFile, "title" | "description" | "triggers"> {
  const intro = safeReadIntro(filePath);
  const frontmatter = frontmatterFor(intro);
  const title = intro.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filePath);
  const description =
    frontmatter.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim() ||
    intro
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("---") && !line.startsWith("#")) ||
    "No description";
  return { title, description, triggers: triggersFromFrontmatter(frontmatter) };
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

function ancestorsFromRoot(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);

  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.reverse();
}

function collectRules(cwd: string): RuleFile[] {
  const candidates: Array<{ source: RuleSource; dir: string }> = [
    { source: "global", dir: GLOBAL_RULES_DIR },
  ];

  for (const ancestor of ancestorsFromRoot(cwd)) {
    candidates.push({ source: "project", dir: path.join(ancestor, ".pi", "rules") });
    candidates.push({ source: "agents", dir: path.join(ancestor, ".agents", "rules") });
    candidates.push({ source: "claude", dir: path.join(ancestor, ".claude", "rules") });
  }

  const seen = new Set<string>();
  const rules: RuleFile[] = [];

  for (const candidate of candidates) {
    for (const filePath of findMarkdownFiles(candidate.dir)) {
      const absolutePath = path.resolve(filePath);
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);

      const meta = metadataFor(absolutePath);
      rules.push({
        source: candidate.source,
        absolutePath,
        title: meta.title,
        description: meta.description,
        triggers: meta.triggers,
      });
    }
  }

  return rules;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function triggerMatches(prompt: string, trigger: string): boolean {
  const normalizedPrompt = normalizeText(prompt);
  const normalizedTrigger = normalizeText(trigger);
  if (!normalizedTrigger) return false;

  if (/^[a-z0-9][a-z0-9+_.\-/ ]*$/i.test(normalizedTrigger)) {
    const pattern = normalizedTrigger
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    return new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i").test(normalizedPrompt);
  }

  return normalizedPrompt.includes(normalizedTrigger);
}

function matchedRulesForPrompt(rules: RuleFile[], prompt: string): RuleFile[] {
  return rules
    .map((rule, index) => ({
      rule,
      index,
      specificity: rule.triggers.reduce(
        (longest, trigger) => (triggerMatches(prompt, trigger) ? Math.max(longest, normalizeText(trigger).length) : longest),
        0,
      ),
    }))
    .filter((candidate) => candidate.specificity > 0)
    .sort((left, right) => right.specificity - left.specificity || left.index - right.index)
    .slice(0, MAX_ACTIVE_RULES)
    .map((candidate) => candidate.rule);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const candidate = item as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function previousUserPrompt(entries: SessionEntryLike[], currentPrompt: string): string {
  const normalizedCurrent = normalizeText(currentPrompt);
  let skippedCurrent = false;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = messageText(entry.message.content).trim();
    if (!text) continue;
    if (!skippedCurrent && normalizeText(text) === normalizedCurrent) {
      skippedCurrent = true;
      continue;
    }
    return text;
  }

  return "";
}

function meaningfulTopicOverlap(previous: string, current: string): boolean {
  const previousText = normalizeText(previous);
  const currentText = normalizeText(current);
  const ignoredCjkPairs = new Set(["公司", "股票", "股价", "如何", "怎么", "这个", "那个", "什么", "可以"]);
  const previousCjkPairs = new Set(previousText.match(/[\p{Script=Han}]{2}/gu) ?? []);
  for (const pair of currentText.match(/[\p{Script=Han}]{2}/gu) ?? []) {
    if (!ignoredCjkPairs.has(pair) && previousCjkPairs.has(pair)) return true;
  }

  const ignoredWords = new Set(["about", "company", "could", "please", "stock", "that", "this", "what", "with", "would"]);
  const previousWords = new Set(previousText.match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []);
  for (const word of currentText.match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []) {
    if (!ignoredWords.has(word) && previousWords.has(word)) return true;
  }

  return false;
}

function isContextualFollowUp(prompt: string, priorPrompt: string): boolean {
  const normalized = normalizeText(prompt);
  if (!normalized || normalized.length > 120) return false;

  if (/^(?:继续|接着|然后呢|再说说|详细说说|展开说说|为什么|为何|那呢|这个呢|它呢|他呢|她呢|能买吗|值得吗|适合吗)(?:[\s，,。.!?？！…].*)?$/u.test(normalized)) {
    return true;
  }
  if (/^(?:continue|go on|why|what about|how about)(?:\b|\s)/i.test(normalized)) {
    return true;
  }

  const asksForEvaluation = /(?:怎么样|如何(?:呀|呢)?|怎么看|能买吗|值得吗|适合吗|why|what about it|how about it)[?？!！。…]*$/iu.test(normalized);
  return asksForEvaluation && meaningfulTopicOverlap(priorPrompt, prompt);
}

function activeRulePathsFromEntries(entries: SessionEntryLike[]): string[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== ACTIVE_RULE_STATE_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object") return [];
    const state = entry.data as Partial<ActiveRuleState>;
    if (state.schema !== ACTIVE_RULE_STATE_SCHEMA || !Array.isArray(state.activeRulePaths)) return [];
    return state.activeRulePaths.filter((value): value is string => typeof value === "string");
  }

  return undefined;
}

function activeRulesFromEntries(entries: SessionEntryLike[], rules: RuleFile[]): RuleFile[] {
  const paths = activeRulePathsFromEntries(entries);
  if (!paths) return [];
  const rulesByPath = new Map(rules.map((rule) => [rule.absolutePath, rule]));
  return paths.map((rulePath) => rulesByPath.get(rulePath)).filter((rule): rule is RuleFile => Boolean(rule));
}

function sameRulePaths(left: RuleFile[], right: RuleFile[]): boolean {
  return left.length === right.length && left.every((rule, index) => rule.absolutePath === right[index]?.absolutePath);
}

function formatRules(rules: RuleFile[]): string {
  return rules
    .map((rule) => {
      const triggers = rule.triggers.length > 0 ? rule.triggers.join(", ") : "none";
      return `- [${rule.source}] ${rule.absolutePath} - ${rule.title}: ${rule.description} (triggers: ${triggers})`;
    })
    .join("\n");
}

function loadActiveRuleBlocks(activeRules: RuleFile[]): { blocks: string; errors: string[] } {
  const blocks: string[] = [];
  const errors: string[] = [];

  for (const rule of activeRules) {
    try {
      const body = fs.readFileSync(rule.absolutePath, "utf8").trim();
      if (!body) {
        errors.push(`- [${rule.source}] ${rule.absolutePath}: matched rule is empty`);
        continue;
      }
      blocks.push(`#### [${rule.source}] ${rule.title}\nPath: ${rule.absolutePath}\n\n----- BEGIN ACTIVE RULE -----\n${body}\n----- END ACTIVE RULE -----`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "READ_FAILED";
      errors.push(`- [${rule.source}] ${rule.absolutePath}: unable to read matched rule (${code})`);
    }
  }

  return { blocks: blocks.join("\n\n"), errors };
}

function formatLoaderPrompt(rules: RuleFile[], activeRules: RuleFile[], activation: "direct" | "inherited" | "none"): { prompt: string; errors: string[] } {
  const loaded = loadActiveRuleBlocks(activeRules);
  const activeSection = activeRules.length > 0
    ? `### Active Rule Files\n\nActivation: ${activation}. These matched rules are loaded in full and are mandatory for this turn.\n\n${loaded.blocks || "No matched rule body could be loaded."}`
    : "### Active Rule Files\n\nNo rule matched the current prompt. Use the AGENTS routing contract and read the minimum relevant indexed rule for non-trivial work.";
  const errorSection = loaded.errors.length > 0
    ? `\n\n### Rule Load Errors\n\n${loaded.errors.join("\n")}\n\nDo not claim that an unreadable matched rule was applied.`
    : "";

  return {
    prompt: `## Pi Rules Loader

Rule frontmatter triggers are matched against the current user prompt. Direct matches replace the prior active route; short contextual follow-ups may inherit the prior active route. At most ${MAX_ACTIVE_RULES} rule files are loaded in full.

### Available Rule Files

${formatRules(rules)}

${activeSection}${errorSection}

### Rule Use Contract

- Follow every loaded active rule for this turn; do not substitute a generic tool flow for a rule-mandated Skill workflow.
- Read only the minimum relevant installed SKILL.md files named by an active rule, and report only Skills and tools actually used.
- Do not read every indexed rule by default. If no trigger matched but AGENTS requires a rule, read that rule explicitly before non-trivial work.
- If a matched rule cannot be read, keep the failure observable and proceed only with AGENTS plus verified context.
`,
    errors: loaded.errors,
  };
}

export default function piRulesLoader(pi: ExtensionAPI) {
  let rules: RuleFile[] = [];

  pi.on("session_start", async (_event, ctx) => {
    rules = collectRules(ctx.cwd);
    if (rules.length > 0) {
      ctx.ui.notify(`Pi rules loader indexed ${rules.length} rule file(s).`, "info");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (rules.length === 0) {
      return;
    }

    const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
    const previousActiveRules = activeRulesFromEntries(branch, rules);
    const directMatches = matchedRulesForPrompt(rules, event.prompt);
    const priorPrompt = previousUserPrompt(branch, event.prompt);
    const inheritPrevious = directMatches.length === 0 && previousActiveRules.length > 0 && isContextualFollowUp(event.prompt, priorPrompt);
    const activeRules = directMatches.length > 0 ? directMatches : inheritPrevious ? previousActiveRules : [];
    const activation = directMatches.length > 0 ? "direct" : inheritPrevious ? "inherited" : "none";

    if (!sameRulePaths(previousActiveRules, activeRules)) {
      pi.appendEntry(ACTIVE_RULE_STATE_TYPE, {
        schema: ACTIVE_RULE_STATE_SCHEMA,
        activeRulePaths: activeRules.map((rule) => rule.absolutePath),
      } satisfies ActiveRuleState);
      if (activeRules.length > 0) {
        ctx.ui.notify(`Pi rules loader activated ${activeRules.map((rule) => path.basename(rule.absolutePath)).join(", ")}.`, "info");
      }
    }

    const loader = formatLoaderPrompt(rules, activeRules, activation);
    if (loader.errors.length > 0) {
      ctx.ui.notify(`Pi rules loader could not read ${loader.errors.length} matched rule file(s).`, "warning");
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${loader.prompt}`,
    };
  });
}
