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
const bridgePath = path.join(repoRoot, "extensions", "pi-vision-bridge", "index.ts");

function loadBridgeFactory() {
  const require = createRequire(import.meta.url);
  const { createJiti } = require(path.join(repoRoot, "npm", "node_modules", "jiti"));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const loaded = jiti(bridgePath);
  return loaded.default ?? loaded;
}

test("registers vision_read as an explicit text-only fallback without global prompt bias", () => {
  const tools = [];
  loadBridgeFactory()({
    registerTool(tool) {
      tools.push(tool);
    },
  });

  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "vision_read");
  assert.equal(tool.label, "Vision Read");
  assert.equal(typeof tool.execute, "function");
  assert.equal(Object.hasOwn(tool, "promptSnippet"), false);
  assert.match(tool.description, /仅当当前模型或 provider 无法原生接收图片时/);
  assert.match(tool.description, /原生多模态模型应直接接收图片/);
  assert.match(tool.description, /text-only provider/);
  assert.doesNotMatch(tool.description, /图片任务优先调用它|优先调用 vision_read/);
  assert.deepEqual(tool.parameters.required, ["image"]);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("real upstream Pi keeps vision_read active without injecting the legacy prompt bias", { timeout: 20_000 }, (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-vision-bridge-runtime-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const agentDir = path.join(tempRoot, ".pi", "agent");
  const projectDir = path.join(tempRoot, "project");
  const markerPath = path.join(tempRoot, "captured-vision-runtime.json");
  const probePath = path.join(tempRoot, "capture-vision-runtime.ts");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`, "utf8");
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n", "utf8");
  fs.writeFileSync(
    probePath,
    `import { writeFileSync } from "node:fs";
export default function captureVisionRuntime(pi: any) {
  pi.on("before_agent_start", (event: any) => {
    const marker = process.env.PI67_VISION_RUNTIME_MARKER;
    if (!marker) throw new Error("PI67_VISION_RUNTIME_MARKER is required");
    const tool = pi.getAllTools().find((item: any) => item.name === "vision_read");
    writeFileSync(marker, JSON.stringify({
      systemPrompt: event.systemPrompt,
      activeTools: pi.getActiveTools(),
      tool: tool ? { name: tool.name, description: tool.description } : null,
    }), "utf8");
    process.exit(0);
  });
}
`,
    "utf8",
  );

  const defaultPiBin = path.join(repoRoot, "npm", "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const piBin = process.env.PI67_VISION_BRIDGE_PI_BIN || defaultPiBin;
  const result = spawnSync(
    piBin,
    [
      "--offline",
      "--no-extensions",
      "--extension",
      bridgePath,
      "--extension",
      probePath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-builtin-tools",
      "--tools",
      "vision_read",
      "--no-session",
      "--provider",
      "deepseek",
      "--model",
      "deepseek-chat",
      "--api-key",
      "fixture-not-a-secret",
      "--print",
      "读取 screenshot.png",
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
        PI67_VISION_RUNTIME_MARKER: markerPath,
      },
      shell: process.platform === "win32",
      timeout: 15_000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Pi runtime probe failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(fs.existsSync(markerPath), true, "probe did not capture the Pi runtime state");
  const captured = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.deepEqual(captured.activeTools, ["vision_read"]);
  assert.equal(captured.tool?.name, "vision_read");
  assert.match(captured.tool?.description ?? "", /text-only provider/);
  assert.doesNotMatch(captured.systemPrompt, /图片任务优先调用它/);
  assert.doesNotMatch(captured.systemPrompt, /优先调用 vision_read/);
  assert.doesNotMatch(captured.systemPrompt, /遇到图片、截图、OCR、看图、读图、分析图片路径时/);
});
