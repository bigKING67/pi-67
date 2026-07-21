import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");
const loaderPath = path.join(repoRoot, "extensions", "pi-rules-loader", "index.ts");

function writeRule(filePath, { description, triggers, body }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const triggerFrontmatter = Array.isArray(triggers)
    ? `triggers:\n${triggers.map((trigger) => `  - ${trigger}`).join("\n")}`
    : `triggers: ${triggers}`;
  fs.writeFileSync(
    filePath,
    `---\ndescription: ${description}\n${triggerFrontmatter}\n---\n\n# ${description}\n\n${body}\n`,
    "utf8",
  );
}

function createHarness(factory, initialEntries = []) {
  const handlers = new Map();
  const entries = [...initialEntries];
  const notifications = [];
  let nextId = entries.length;
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry(customType, data) {
      entries.push({
        type: "custom",
        id: `custom-${nextId += 1}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
  };
  factory(pi);

  const ctx = {
    cwd: "",
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getBranch() {
        return [...entries];
      },
    },
  };

  return {
    entries,
    notifications,
    async start(cwd) {
      ctx.cwd = cwd;
      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    },
    async turn(prompt) {
      entries.push({
        type: "message",
        id: `user-${nextId += 1}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      });
      return handlers.get("before_agent_start")(
        {
          type: "before_agent_start",
          prompt,
          systemPrompt: "BASE_SYSTEM_PROMPT",
          systemPromptOptions: {},
        },
        ctx,
      );
    },
  };
}

test("matches triggers, injects only active rules, inherits follow-ups, clears topic changes, and reports read failures", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-rules-loader-unit-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = tempRoot;
  process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, ".pi", "agent");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const rulesDir = path.join(tempRoot, ".pi", "agent", "rules");
  const investmentPath = path.join(rulesDir, "investment.md");
  const qualityPath = path.join(rulesDir, "quality.md");
  const fragilePath = path.join(rulesDir, "fragile.md");
  writeRule(investmentPath, {
    description: "Investment route",
    triggers: "股票, 股价, 投资",
    body: "INVESTMENT_FULL_BODY_MARKER",
  });
  writeRule(qualityPath, {
    description: "Quality route",
    triggers: "bugfix, tests",
    body: "QUALITY_FULL_BODY_MARKER",
  });
  writeRule(fragilePath, {
    description: "Fragile route",
    triggers: ["fragile", "unreadable"],
    body: "FRAGILE_FULL_BODY_MARKER",
  });

  const require = createRequire(import.meta.url);
  const { createJiti } = require(path.join(repoRoot, "npm", "node_modules", "jiti"));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const loaded = jiti(loaderPath);
  const factory = loaded.default ?? loaded;
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const harness = createHarness(factory);
  await harness.start(projectDir);

  const direct = await harness.turn("世运电路股价");
  assert.match(direct.systemPrompt, /Activation: direct/);
  assert.match(direct.systemPrompt, /INVESTMENT_FULL_BODY_MARKER/);
  assert.doesNotMatch(direct.systemPrompt, /QUALITY_FULL_BODY_MARKER/);
  assert.doesNotMatch(direct.systemPrompt, /FRAGILE_FULL_BODY_MARKER/);
  assert.equal(harness.entries.at(-1).customType, "pi-rules-loader.active-rules");
  assert.deepEqual(harness.entries.at(-1).data.activeRulePaths, [investmentPath]);

  const inherited = await harness.turn("世运电路如何呀");
  assert.match(inherited.systemPrompt, /Activation: inherited/);
  assert.match(inherited.systemPrompt, /INVESTMENT_FULL_BODY_MARKER/);

  const unrelated = await harness.turn("帮我修一个 TypeScript bug");
  assert.match(unrelated.systemPrompt, /No rule matched the current prompt/);
  assert.doesNotMatch(unrelated.systemPrompt, /INVESTMENT_FULL_BODY_MARKER/);
  assert.deepEqual(harness.entries.at(-1).data.activeRulePaths, []);

  fs.unlinkSync(fragilePath);
  const unreadable = await harness.turn("fragile");
  assert.match(unreadable.systemPrompt, /unable to read matched rule \(ENOENT\)/);
  assert.doesNotMatch(unreadable.systemPrompt, /FRAGILE_FULL_BODY_MARKER/);
  assert.ok(harness.notifications.some((entry) => entry.level === "warning" && /could not read 1 matched rule/.test(entry.message)));

  const investmentAgain = await harness.turn("世运电路股价");
  assert.match(investmentAgain.systemPrompt, /Activation: direct/);

  const resumed = createHarness(factory, harness.entries);
  await resumed.start(projectDir);
  const resumedFollowUp = await resumed.turn("继续");
  assert.match(resumedFollowUp.systemPrompt, /Activation: inherited/);
  assert.match(resumedFollowUp.systemPrompt, /INVESTMENT_FULL_BODY_MARKER/);
});

test("real upstream Pi injects a directly matched route before the provider request", { timeout: 20_000 }, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-rules-loader-runtime-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const agentDir = path.join(tempRoot, ".pi", "agent");
  const rulesDir = path.join(agentDir, "rules");
  const projectDir = path.join(tempRoot, "project");
  const markerPath = path.join(tempRoot, "captured-system-prompt.txt");
  const probePath = path.join(tempRoot, "capture-prompt.ts");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "rules", "investment.md"), path.join(rulesDir, "investment.md"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`, "utf8");
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n", "utf8");
  fs.writeFileSync(
    probePath,
    `import { writeFileSync } from "node:fs";
export default function capturePrompt(pi: any) {
  pi.on("before_agent_start", (event: any) => {
    const marker = process.env.PI67_RULES_PROMPT_MARKER;
    if (!marker) throw new Error("PI67_RULES_PROMPT_MARKER is required");
    writeFileSync(marker, event.systemPrompt, "utf8");
    process.exit(0);
  });
}
`,
    "utf8",
  );

  const defaultPiBin = path.join(repoRoot, "npm", "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const piBin = process.env.PI67_RULES_LOADER_PI_BIN || defaultPiBin;
  const result = spawnSync(
    piBin,
    [
      "--offline",
      "--no-extensions",
      "--extension",
      loaderPath,
      "--extension",
      probePath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--no-session",
      "--provider",
      "deepseek",
      "--model",
      "deepseek-chat",
      "--api-key",
      "fixture-not-a-secret",
      "--print",
      "世运电路股价",
    ],
    {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "sessions"),
        PI_OFFLINE: "1",
        PI67_RULES_PROMPT_MARKER: markerPath,
      },
      shell: process.platform === "win32",
      timeout: 15_000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Pi runtime probe failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(fs.existsSync(markerPath), true, "probe did not capture the chained system prompt");
  const capturedPrompt = fs.readFileSync(markerPath, "utf8");
  assert.match(capturedPrompt, /Activation: direct/);
  assert.match(capturedPrompt, /# Investment Research Rule/);
  assert.match(capturedPrompt, /investment-checklist/);
  assert.match(capturedPrompt, /generic `web_search`\/`web_fetch` flow may collect evidence but must not replace this Skill route/);
});
