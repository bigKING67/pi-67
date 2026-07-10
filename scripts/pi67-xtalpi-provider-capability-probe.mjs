#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { readJsonFile: readJsonFileCompatible } = require("./pi67-json-utils.cjs");

const SCHEMA = "xtalpi-pi-tools.provider-capabilities.v1";
const DEFAULT_BASE_URL = "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_JSON_ACTION_RUNS = 3;

function usage() {
  console.log(`Usage:
  pi67-xtalpi-provider-capability-probe.mjs [options]

Options:
  --agent-dir DIR        Pi agent dir. Defaults to ~/.pi/agent.
  --provider ID          Provider id. Defaults to xtalpi-pi-tools.
  --model ID             Model id. Defaults to deepseek-v4-pro.
  --timeout-ms MS        Per-probe request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --json-action-runs N   Repeated JSON action probes. Defaults to ${DEFAULT_JSON_ACTION_RUNS}.
  --skip-native-probes   Skip native tools / role=tool probes.
  --output-file FILE     Write JSON result to FILE as well as stdout.
  --self-test            Run offline classifier self-test.
  -h, --help             Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    agentDir: path.join(process.env.HOME || ".", ".pi", "agent"),
    provider: "xtalpi-pi-tools",
    model: "deepseek-v4-pro",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    jsonActionRuns: DEFAULT_JSON_ACTION_RUNS,
    skipNativeProbes: false,
    outputFile: "",
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--agent-dir":
        args.agentDir = argv[++index] || "";
        break;
      case "--provider":
        args.provider = argv[++index] || "";
        break;
      case "--model":
        args.model = argv[++index] || "";
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(argv[++index] || "");
        break;
      case "--json-action-runs":
        args.jsonActionRuns = Number(argv[++index] || "");
        break;
      case "--skip-native-probes":
        args.skipNativeProbes = true;
        break;
      case "--output-file":
        args.outputFile = argv[++index] || "";
        break;
      case "--self-test":
        args.selfTest = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.help && !args.selfTest) {
    if (!args.agentDir) throw new Error("--agent-dir requires a path");
    if (!args.provider) throw new Error("--provider requires an id");
    if (!args.model) throw new Error("--model requires an id");
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) {
      throw new Error("--timeout-ms must be an integer >= 1000");
    }
    if (!Number.isInteger(args.jsonActionRuns) || args.jsonActionRuns < 1 || args.jsonActionRuns > 10) {
      throw new Error("--json-action-runs must be an integer between 1 and 10");
    }
  }

  return args;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isPlaceholderKey(value) {
  const raw = String(value || "").trim();
  return !raw || raw.includes("YOUR_") || raw.includes("REPLACE_") || raw === "changeme" || /^<[^>]+>$/.test(raw);
}

function readJsonFile(file) {
  return readJsonFileCompatible(file);
}

function loadProviderConfig(args) {
  const modelsFile = path.join(args.agentDir, "models.json");
  const models = fs.existsSync(modelsFile) ? readJsonFile(modelsFile) : {};
  const providers = isObject(models.providers) ? models.providers : {};
  const provider = isObject(providers[args.provider]) ? providers[args.provider] : {};
  const baseUrl = normalizeBaseUrl(
    process.env.XTALPI_PI_TOOLS_BASE_URL ||
      process.env.XTALPI_BASE_URL ||
      provider.baseUrl ||
      DEFAULT_BASE_URL,
  );
  const apiKey =
    process.env.XTALPI_PI_TOOLS_API_KEY ||
    process.env.XTALPI_API_KEY ||
    provider.apiKey ||
    "";

  return {
    baseUrl,
    endpoint: `${baseUrl}/chat/completions`,
    apiKey,
    apiKeyConfigured: !isPlaceholderKey(apiKey),
  };
}

function truncate(value, max = 240) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function parseMaybeJson(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function extractChatMessage(root) {
  const choice = Array.isArray(root?.choices) ? root.choices.find(isObject) : undefined;
  const message = isObject(choice?.message) ? choice.message : {};
  return {
    responseModel: typeof root?.model === "string" ? root.model : undefined,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    message,
    content: typeof message.content === "string" ? message.content : "",
    hasToolCalls: Array.isArray(message.tool_calls),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    messageKeys: Object.keys(message).sort(),
  };
}

function baseProbeFields(input) {
  return {
    name: input.name,
    status: input.status,
    elapsedMs: input.elapsedMs,
    httpOk: input.status >= 200 && input.status < 300,
  };
}

function classifyPlainChat(input) {
  const parsed = parseMaybeJson(input.body);
  if (!parsed.ok) {
    return { ...baseProbeFields(input), ok: false, supported: false, errorCode: "non_json_response", bodyPreview: truncate(input.body) };
  }
  const chat = extractChatMessage(parsed.value);
  const ok = input.status === 200 && chat.content.trim() === "PI_CAPABILITY_PLAIN_OK";
  return {
    ...baseProbeFields(input),
    ok,
    supported: ok,
    responseModel: chat.responseModel,
    finishReason: chat.finishReason,
    contentPreview: truncate(chat.content),
    messageKeys: chat.messageKeys,
  };
}

function classifyJsonObject(input) {
  const parsed = parseMaybeJson(input.body);
  if (!parsed.ok) {
    return { ...baseProbeFields(input), ok: false, supported: false, errorCode: "non_json_response", bodyPreview: truncate(input.body) };
  }
  const chat = extractChatMessage(parsed.value);
  const contentJson = parseMaybeJson(chat.content);
  const ok = input.status === 200 &&
    contentJson.ok &&
    contentJson.value?.ok === true &&
    contentJson.value?.marker === "PI_CAPABILITY_JSON_OBJECT_OK";
  return {
    ...baseProbeFields(input),
    ok,
    supported: ok,
    responseModel: chat.responseModel,
    finishReason: chat.finishReason,
    contentJsonOk: contentJson.ok,
    contentPreview: truncate(chat.content),
  };
}

function classifyJsonSchemaStrict(input) {
  const parsed = parseMaybeJson(input.body);
  if (!parsed.ok) {
    return { ...baseProbeFields(input), ok: false, supported: false, errorCode: "non_json_response", bodyPreview: truncate(input.body) };
  }
  const chat = extractChatMessage(parsed.value);
  const contentJson = parseMaybeJson(chat.content);
  const ok = input.status === 200 &&
    contentJson.ok &&
    contentJson.value?.kind === "final" &&
    contentJson.value?.marker === "PI_CAPABILITY_JSON_SCHEMA_OK" &&
    Object.keys(contentJson.value).sort().join(",") === "kind,marker";
  return {
    ...baseProbeFields(input),
    ok,
    supported: ok,
    responseModel: chat.responseModel,
    finishReason: chat.finishReason,
    contentJsonOk: contentJson.ok,
    contentPreview: truncate(chat.content),
    note: ok ? "json_schema strict honored" : "json_schema strict was rejected, ignored, or did not enforce schema",
  };
}

function classifyNativeToolCall(input, strictExpected = false) {
  const parsed = parseMaybeJson(input.body);
  if (!parsed.ok) {
    return {
      ...baseProbeFields(input),
      ok: false,
      supported: false,
      errorCode: "non_json_response",
      bodyPreview: truncate(input.body),
    };
  }
  const chat = extractChatMessage(parsed.value);
  const firstToolCall = chat.toolCalls.find(isObject);
  const fn = isObject(firstToolCall?.function) ? firstToolCall.function : {};
  const args = typeof fn.arguments === "string" ? parseMaybeJson(fn.arguments) : { ok: false };
  const ok = input.status === 200 &&
    chat.hasToolCalls &&
    typeof fn.name === "string" &&
    fn.name === "read_package" &&
    args.ok &&
    args.value?.path === "package.json";
  return {
    ...baseProbeFields(input),
    ok,
    supported: ok,
    responseModel: chat.responseModel,
    finishReason: chat.finishReason,
    hasToolCalls: chat.hasToolCalls,
    toolCallCount: chat.toolCalls.length,
    firstToolName: typeof fn.name === "string" ? fn.name : undefined,
    argumentsJsonOk: args.ok,
    contentPreview: truncate(chat.content),
    messageKeys: chat.messageKeys,
    note: ok
      ? strictExpected ? "native strict tool call honored" : "native tool call honored"
      : strictExpected ? "native strict tools unavailable or incompatible" : "native tools unavailable or incompatible",
  };
}

function classifyRoleTool(input) {
  const parsed = parseMaybeJson(input.body);
  if (!parsed.ok) {
    return { ...baseProbeFields(input), ok: false, supported: false, errorCode: "non_json_response", bodyPreview: truncate(input.body) };
  }
  const chat = extractChatMessage(parsed.value);
  const ok = input.status === 200 &&
    chat.finishReason !== "length" &&
    /PI_CAPABILITY_ROLE_TOOL_OK/.test(chat.content);
  return {
    ...baseProbeFields(input),
    ok,
    supported: ok,
    responseModel: chat.responseModel,
    finishReason: chat.finishReason,
    contentPreview: truncate(chat.content),
    messageKeys: chat.messageKeys,
    note: ok ? "role=tool continuation honored" : "role=tool continuation unavailable or unreliable",
  };
}

function classifyJsonAction(input) {
  const parsed = parseMaybeJson(input.body);
  if (!parsed.ok) {
    return { ...baseProbeFields(input), ok: false, supported: false, errorCode: "non_json_response", bodyPreview: truncate(input.body) };
  }
  const chat = extractChatMessage(parsed.value);
  const actionJson = parseMaybeJson(chat.content);
  const ok = input.status === 200 &&
    chat.finishReason === "stop" &&
    actionJson.ok &&
    actionJson.value?.kind === "tool_call" &&
    actionJson.value?.name === "read" &&
    isObject(actionJson.value?.arguments) &&
    actionJson.value.arguments.path === "package.json";
  return {
    ...baseProbeFields(input),
    ok,
    supported: ok,
    responseModel: chat.responseModel,
    finishReason: chat.finishReason,
    contentJsonOk: actionJson.ok,
    action: actionJson.ok ? actionJson.value : undefined,
    contentPreview: truncate(chat.content),
    note: ok ? "json_object can carry local JSON action protocol" : "json_object action failed or was truncated",
  };
}

function recommendedMode(summary) {
  if (summary.nativeTools?.supported && summary.nativeStrictTools?.supported && summary.roleTool?.supported) {
    return "native_strict_tools";
  }
  if (summary.jsonAction?.ok) {
    return "local_json_action_protocol";
  }
  return "unsupported_json_action";
}

function makeProbeDefinitions(model, skipNativeProbes) {
  const probes = [
    {
      name: "plain_chat",
      classify: classifyPlainChat,
      payload: {
        model,
        stream: false,
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: "user", content: "Reply exactly: PI_CAPABILITY_PLAIN_OK" }],
      },
    },
    {
      name: "json_object",
      classify: classifyJsonObject,
      payload: {
        model,
        stream: false,
        max_tokens: 128,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a helpful assistant designed to output JSON." },
          { role: "user", content: "Return JSON exactly with ok true and marker PI_CAPABILITY_JSON_OBJECT_OK." },
        ],
      },
    },
    {
      name: "json_schema_strict",
      classify: classifyJsonSchemaStrict,
      payload: {
        model,
        stream: false,
        max_tokens: 128,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pi_capability",
            strict: true,
            schema: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["final"] },
                marker: { type: "string" },
              },
              required: ["kind", "marker"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: "Return kind final and marker PI_CAPABILITY_JSON_SCHEMA_OK." }],
      },
    },
  ];

  if (!skipNativeProbes) {
    probes.push(
      {
        name: "native_tools_forced",
        classify: (input) => classifyNativeToolCall(input, false),
        payload: {
          model,
          stream: false,
          max_tokens: 128,
          temperature: 0,
          tools: [
            {
              type: "function",
              function: {
                name: "read_package",
                description: "Read package metadata",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "read_package" } },
          parallel_tool_calls: false,
          messages: [{ role: "user", content: "Call read_package with path package.json." }],
        },
      },
      {
        name: "native_tools_strict_forced",
        classify: (input) => classifyNativeToolCall(input, true),
        payload: {
          model,
          stream: false,
          max_tokens: 128,
          temperature: 0,
          tools: [
            {
              type: "function",
              function: {
                name: "read_package",
                description: "Read package metadata",
                strict: true,
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "read_package" } },
          parallel_tool_calls: false,
          messages: [{ role: "user", content: "Call read_package with path package.json." }],
        },
      },
      {
        name: "role_tool_followup",
        classify: classifyRoleTool,
        payload: {
          model,
          stream: false,
          max_tokens: 128,
          temperature: 0,
          messages: [
            { role: "user", content: "Use the previous tool result and reply marker only." },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_probe",
                  type: "function",
                  function: { name: "read_package", arguments: "{\"path\":\"package.json\"}" },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_probe",
              name: "read_package",
              content: "{\"name\":\"pi-extensions\",\"marker\":\"PI_CAPABILITY_ROLE_TOOL_OK\"}",
            },
          ],
        },
      },
    );
  }

  return probes;
}

function makeJsonActionProbe(model, index) {
  return {
    name: `json_action_${index}`,
    classify: classifyJsonAction,
    payload: {
      model,
      stream: false,
      max_tokens: 512,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Pi action selector. Return only compact JSON. " +
            "Use exactly this JSON shape when a tool is needed: " +
            "{\"kind\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"package.json\"}}. " +
            "No markdown. JSON only.",
        },
        {
          role: "user",
          content: "Need local package metadata. Choose a tool call action for read path package.json.",
        },
      ],
    },
  };
}

async function runHttpProbe(endpoint, apiKey, probe, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(probe.payload),
      signal: controller.signal,
    });
    const body = await response.text();
    const classified = probe.classify({
      name: probe.name,
      status: response.status,
      elapsedMs: Date.now() - started,
      body,
    });
    if (!response.ok) {
      classified.errorBodyPreview = truncate(body.replaceAll(apiKey, "[REDACTED]"), 500);
    }
    return classified;
  } catch (error) {
    return {
      name: probe.name,
      status: "transport_error",
      elapsedMs: Date.now() - started,
      httpOk: false,
      ok: false,
      supported: false,
      errorCode: error?.name === "AbortError" ? "request_timeout" : "network_error",
      error: error?.name || "Error",
      message: truncate(error?.message || String(error), 500),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(results) {
  const byName = new Map(results.map((result) => [result.name, result]));
  const jsonActionRuns = results.filter((result) => result.name.startsWith("json_action_"));
  const jsonActionPasses = jsonActionRuns.filter((result) => result.ok).length;
  const summary = {
    plainChat: byName.get("plain_chat"),
    jsonObject: byName.get("json_object"),
    jsonSchemaStrict: byName.get("json_schema_strict"),
    nativeTools: byName.get("native_tools_forced"),
    nativeStrictTools: byName.get("native_tools_strict_forced"),
    roleTool: byName.get("role_tool_followup"),
    jsonAction: {
      ok: jsonActionRuns.length > 0 && jsonActionPasses === jsonActionRuns.length,
      supported: jsonActionRuns.length > 0 && jsonActionPasses === jsonActionRuns.length,
      passes: jsonActionPasses,
      runs: jsonActionRuns.length,
      failures: jsonActionRuns.filter((result) => !result.ok).map((result) => ({
        name: result.name,
        status: result.status,
        finishReason: result.finishReason,
        errorCode: result.errorCode,
        note: result.note,
      })),
    },
  };
  const probeCompleted = results.length > 0 && results.every((result) => result.status !== "transport_error");
  const runtimeReady = summary.plainChat?.ok === true &&
    summary.jsonObject?.ok === true &&
    summary.jsonAction.ok === true;
  return {
    ...summary,
    probeCompleted,
    runtimeReady,
    recommendedMode: recommendedMode(summary),
  };
}

async function runLive(args) {
  const config = loadProviderConfig(args);
  const result = {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    provider: args.provider,
    model: args.model,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
    timeoutMs: args.timeoutMs,
    jsonActionRunsConfigured: args.jsonActionRuns,
    nativeProbesSkipped: args.skipNativeProbes,
    probeCompleted: false,
    runtimeReady: false,
    ok: false,
    recommendedMode: "unknown",
    summary: {},
    probes: [],
  };

  if (!config.apiKeyConfigured) {
    result.summary = { errorCode: "api_key_missing" };
    result.probes.push({
      name: "preflight",
      ok: false,
      supported: false,
      errorCode: "api_key_missing",
      message: "Set XTALPI_PI_TOOLS_API_KEY or configure models.json providers.xtalpi-pi-tools.apiKey.",
    });
    return result;
  }

  const probes = makeProbeDefinitions(args.model, args.skipNativeProbes);
  for (const probe of probes) {
    result.probes.push(await runHttpProbe(config.endpoint, config.apiKey, probe, args.timeoutMs));
  }
  for (let index = 1; index <= args.jsonActionRuns; index += 1) {
    result.probes.push(await runHttpProbe(config.endpoint, config.apiKey, makeJsonActionProbe(args.model, index), args.timeoutMs));
  }

  result.summary = summarize(result.probes);
  result.probeCompleted = result.summary.probeCompleted;
  result.runtimeReady = result.summary.runtimeReady;
  result.recommendedMode = result.summary.recommendedMode;
  result.ok = result.runtimeReady;
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fakeInput(name, status, body) {
  return { name, status, elapsedMs: 1, body: JSON.stringify(body) };
}

function runSelfTest() {
  assert(classifyPlainChat(fakeInput("plain_chat", 200, {
    model: "deepseek-v4-pro",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "PI_CAPABILITY_PLAIN_OK" } }],
  })).supported === true, "plain chat classifier failed");

  assert(classifyJsonObject(fakeInput("json_object", 200, {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{\"ok\":true,\"marker\":\"PI_CAPABILITY_JSON_OBJECT_OK\"}" } }],
  })).supported === true, "json_object classifier failed");

  assert(classifyJsonSchemaStrict(fakeInput("json_schema_strict", 200, {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "kind final and marker PI_CAPABILITY_JSON_SCHEMA_OK" } }],
  })).supported === false, "json_schema classifier should reject plain text");

  assert(classifyNativeToolCall(fakeInput("native_tools_forced", 200, {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ type: "function", function: { name: "read_package", arguments: "{\"path\":\"package.json\"}" } }],
      },
    }],
  })).supported === true, "native tool classifier failed");

  assert(classifyRoleTool(fakeInput("role_tool_followup", 200, {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "PI_CAPABILITY_ROLE_TOOL_OK" } }],
  })).supported === true, "role tool classifier failed");

  assert(classifyJsonAction(fakeInput("json_action_1", 200, {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{\"kind\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"package.json\"}}" } }],
  })).supported === true, "json action classifier failed");

  assert(recommendedMode({
    nativeTools: { supported: true },
    nativeStrictTools: { supported: true },
    roleTool: { supported: true },
  }) === "native_strict_tools", "native recommended mode failed");
  assert(recommendedMode({
    jsonObject: { supported: true },
    jsonAction: { ok: true },
  }) === "local_json_action_protocol", "json action recommended mode failed");
  assert(recommendedMode({
    jsonObject: { supported: false },
    jsonAction: { ok: true },
  }) === "local_json_action_protocol", "targeted json action recommended mode failed");
  assert(recommendedMode({}) === "unsupported_json_action", "unsupported JSON action mode failed");

  const definitions = makeProbeDefinitions("deepseek-v4-pro", false);
  assert(definitions.every((probe) => probe.payload.temperature === 0), "all capability probes must be deterministic");
  assert(definitions.find((probe) => probe.name === "plain_chat")?.payload.max_tokens === 256, "plain chat token budget failed");

  const canonicalReady = summarize([
    classifyPlainChat(fakeInput("plain_chat", 200, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "PI_CAPABILITY_PLAIN_OK" } }],
    })),
    classifyJsonObject(fakeInput("json_object", 200, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{\"ok\":true,\"marker\":\"PI_CAPABILITY_JSON_OBJECT_OK\"}" } }],
    })),
    classifyNativeToolCall(fakeInput("native_tools_forced", 400, { error: { message: "unsupported" } })),
    classifyRoleTool(fakeInput("role_tool_followup", 400, { error: { message: "unsupported" } })),
    classifyJsonAction(fakeInput("json_action_1", 200, {
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{\"kind\":\"tool_call\",\"name\":\"read\",\"arguments\":{\"path\":\"package.json\"}}" } }],
    })),
  ]);
  assert(canonicalReady.probeCompleted === true, "completed HTTP probes should be distinguished from transport failure");
  assert(canonicalReady.runtimeReady === true, "native capability failures must not disable canonical runtime");

  const canonicalNotReady = summarize([
    { name: "plain_chat", status: 200, ok: true, supported: true },
    { name: "json_object", status: 200, ok: false, supported: false },
    { name: "json_action_1", status: 200, ok: true, supported: true },
  ]);
  assert(canonicalNotReady.probeCompleted === true, "unsupported capability still completed its probe");
  assert(canonicalNotReady.runtimeReady === false, "json_object is required for canonical runtime");

  const incomplete = summarize([
    { name: "plain_chat", status: "transport_error", ok: false, supported: false },
    { name: "json_object", status: 200, ok: true, supported: true },
    { name: "json_action_1", status: 200, ok: true, supported: true },
  ]);
  assert(incomplete.probeCompleted === false, "transport failure must mark probe run incomplete");
  assert(incomplete.runtimeReady === false, "transport failure must not report runtime ready");

  return {
    schema: "xtalpi-pi-tools.provider-capabilities-self-test.v1",
    ok: true,
    cases: 18,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const result = args.selfTest ? runSelfTest() : await runLive(args);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.outputFile) {
    fs.mkdirSync(path.dirname(path.resolve(args.outputFile)), { recursive: true });
    fs.writeFileSync(args.outputFile, text);
  }
  process.stdout.write(text);
  if (!args.selfTest && !result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
