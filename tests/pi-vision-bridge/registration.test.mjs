import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { upstreamPiInvocation } from "../upstream-pi-runtime.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");
const bridgePath = path.join(repoRoot, "extensions", "pi-vision-bridge", "index.ts");
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function loadBridgeFactory() {
  const require = createRequire(import.meta.url);
  const { createJiti } = require(path.join(repoRoot, "npm", "node_modules", "jiti"));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const loaded = jiti(bridgePath);
  return loaded.default ?? loaded;
}

function registeredVisionTool() {
  const tools = [];
  loadBridgeFactory()({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 1);
  return tools[0];
}

function withVisionEnv(t) {
  const previous = {
    PI67_VISION_BASE_URL: process.env.PI67_VISION_BASE_URL,
    PI67_VISION_API_KEY: process.env.PI67_VISION_API_KEY,
    PI67_VISION_MODEL: process.env.PI67_VISION_MODEL,
    PI67_VISION_PROVIDER: process.env.PI67_VISION_PROVIDER,
  };
  process.env.PI67_VISION_BASE_URL = "https://vision-fixture.invalid/v1";
  process.env.PI67_VISION_API_KEY = "fixture-not-a-secret";
  process.env.PI67_VISION_MODEL = "vision-fixture";
  process.env.PI67_VISION_PROVIDER = "fixture";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
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

test("local images are realpath-confined to the active workspace", async (t) => {
  withVisionEnv(t);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-vision-boundary-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside.png");
  const link = path.join(workspace, "escape.png");
  fs.mkdirSync(workspace);
  fs.writeFileSync(outside, Buffer.from(PNG_DATA_URL.split(",")[1], "base64"));
  fs.symlinkSync(outside, link);
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("unexpected fetch");
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  await assert.rejects(
    registeredVisionTool().execute("fixture", { image: link }, undefined, undefined, { cwd: workspace }),
    /must resolve inside the active workspace/,
  );
  assert.equal(fetched, false);
});

test("data URL input is magic-checked and never echoed in updates or results", async (t) => {
  withVisionEnv(t);
  const previousFetch = globalThis.fetch;
  const updates = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.input[0].content[1].image_url.startsWith("data:image/png;base64,"), true);
    return new Response(JSON.stringify({ output_text: "fixture analysis" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const result = await registeredVisionTool().execute(
    "fixture",
    { image: PNG_DATA_URL },
    undefined,
    (update) => updates.push(update),
    { cwd: repoRoot },
  );
  const rendered = JSON.stringify({ result, updates });
  assert.match(rendered, /data-url:image\/png/);
  assert.equal(rendered.includes(PNG_DATA_URL), false);
});

test("declared data URL MIME must match image magic", async (t) => {
  withVisionEnv(t);
  const mismatched = PNG_DATA_URL.replace("data:image/png", "data:image/jpeg");
  await assert.rejects(
    registeredVisionTool().execute("fixture", { image: mismatched }, undefined, undefined, { cwd: repoRoot }),
    /MIME does not match detected image\/png/,
  );
});

test("local file size is checked before read and extension cannot substitute for image magic", async (t) => {
  withVisionEnv(t);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-vision-local-validation-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const oversized = path.join(workspace, "oversized.png");
  fs.writeFileSync(oversized, "");
  fs.truncateSync(oversized, 20 * 1024 * 1024 + 1);
  await assert.rejects(
    registeredVisionTool().execute("fixture", { image: oversized }, undefined, undefined, { cwd: workspace }),
    /image file is too large/,
  );

  const disguised = path.join(workspace, "not-really-an-image.png");
  fs.writeFileSync(disguised, "plain text fixture");
  await assert.rejects(
    registeredVisionTool().execute("fixture", { image: disguised }, undefined, undefined, { cwd: workspace }),
    /not a supported image format/,
  );
});

test("provider responses are streamed with a hard byte cap", async (t) => {
  withVisionEnv(t);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61), { status: 200 });
  t.after(() => { globalThis.fetch = previousFetch; });

  await assert.rejects(
    registeredVisionTool().execute("fixture", { image: PNG_DATA_URL }, undefined, undefined, { cwd: repoRoot }),
    /vision provider response exceeded 4194304 bytes/,
  );
});

test("host cancellation aborts image/provider IO instead of starting a fallback request", async (t) => {
  withVisionEnv(t);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
    return await new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const controller = new AbortController();
  const pending = registeredVisionTool().execute("fixture", { image: PNG_DATA_URL }, controller.signal, undefined, { cwd: repoRoot });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(calls, 1);
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

  const pi = upstreamPiInvocation(repoRoot, process.env.PI67_VISION_BRIDGE_PI_BIN);
  const result = spawnSync(
    pi.command,
    [
      ...pi.args,
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
      shell: pi.shell,
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
