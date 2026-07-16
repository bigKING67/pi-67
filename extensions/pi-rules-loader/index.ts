import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RuleSource = "global" | "project" | "agents" | "claude";

type RuleFile = {
  source: RuleSource;
  absolutePath: string;
  title: string;
  description: string;
};

const HOME = process.env.HOME ?? "";
const GLOBAL_RULES_DIR = path.join(HOME, ".pi", "agent", "rules");

function safeReadIntro(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, 3000);
  } catch {
    return "";
  }
}

function metadataFor(filePath: string): Pick<RuleFile, "title" | "description"> {
  const intro = safeReadIntro(filePath);
  const title = intro.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filePath);
  const description =
    intro.match(/^---[\s\S]*?\ndescription:\s*(.+?)\s*\n[\s\S]*?---/m)?.[1]?.trim() ||
    intro
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("---") && !line.startsWith("#")) ||
    "No description";
  return { title, description };
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
      });
    }
  }

  return rules;
}

function formatRules(rules: RuleFile[]): string {
  return rules
    .map((rule) => `- [${rule.source}] ${rule.absolutePath} - ${rule.title}: ${rule.description}`)
    .join("\n");
}

export default function piRulesLoader(pi: ExtensionAPI) {
  let rules: RuleFile[] = [];

  pi.on("session_start", async (_event, ctx) => {
    rules = collectRules(ctx.cwd);
    if (rules.length > 0) {
      ctx.ui.notify(`Pi rules loader indexed ${rules.length} rule file(s).`, "info");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (rules.length === 0) {
      return;
    }

    return {
      systemPrompt:
        event.systemPrompt +
        `

## Pi Rules Loader

Detailed rules are indexed below but are not automatically loaded in full. For L1/L2 work, use the global/project AGENTS routing contract and read only the minimum relevant files before planning or editing.

### Available Rule Files

${formatRules(rules)}

### Rule Use Contract

- Do not read every rule by default; read only the smallest relevant set.
- If rule files cannot be read, say so and proceed with the global AGENTS kernel plus project context.
- In final delivery for non-trivial work, briefly mention the key rules used.
`,
    };
  });
}
