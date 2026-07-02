#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1";

function usage() {
  console.log(`Usage:
  pi67-xtalpi-provider-health.mjs [options]

Options:
  --agent-dir DIR      Pi agent dir. Defaults to ~/.pi/agent.
  --provider ID        Provider id. Defaults to xtalpi-pi-tools.
  --model ID           Model id. Defaults to deepseek-v4-pro.
  --timeout-ms MS      Request timeout. Defaults to 10000.
  --output-file FILE   Write JSON result to FILE as well as stdout.
  --self-test          Run offline classifier/redaction self-test.
  -h, --help           Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    agentDir: path.join(process.env.HOME || ".", ".pi", "agent"),
    provider: "xtalpi-pi-tools",
    model: "deepseek-v4-pro",
    timeoutMs: 10000,
    outputFile: "",
    selfTest: false,
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
  }

  return args;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function redactSensitiveString(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._~+\-/=]{8,}/g, "sk-[REDACTED]")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+\-/=]{8,}/gi, "$1[REDACTED]")
    .replace(/(authorization["'\s:=]+)[A-Za-z0-9._~+\-/=]{8,}/gi, "$1[REDACTED]");
}

export function classifyHttpStatus(status) {
  if (status === 401) return { errorCode: "http_401", errorCategory: "authentication", retryable: false };
  if (status === 403) return { errorCode: "http_403", errorCategory: "authentication", retryable: false };
  if (status === 408) return { errorCode: "http_408", errorCategory: "timeout", retryable: true };
  if (status === 429) return { errorCode: "http_429", errorCategory: "rate_limit", retryable: true };
  if (status >= 500) return { errorCode: "http_5xx", errorCategory: "upstream", retryable: true };
  return { errorCode: "http_error", errorCategory: "upstream", retryable: false };
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isPlaceholderKey(value) {
  const raw = String(value || "").trim();
  return !raw || raw.includes("YOUR_") || raw.includes("REPLACE_ME") || /^<[^>]+>$/.test(raw);
}

function resultBase({ provider, model, timeoutMs, startedAt }) {
  return {
    schema: "xtalpi-pi-tools.provider-health.v1",
    createdAt: new Date().toISOString(),
    provider,
    model,
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
  };
}

function writeResult(result, outputFile) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, text);
  }
  process.stdout.write(text);
}

function failure(context, fields) {
  return {
    ...resultBase(context),
    ok: false,
    ...fields,
  };
}

function success(context, fields) {
  return {
    ...resultBase(context),
    ok: true,
    ...fields,
  };
}

async function checkProviderHealth(options) {
  const context = {
    provider: options.provider,
    model: options.model,
    timeoutMs: options.timeoutMs,
    startedAt: Date.now(),
  };

  let models;
  try {
    models = JSON.parse(fs.readFileSync(path.join(options.agentDir, "models.json"), "utf8"));
  } catch (error) {
    return failure(context, {
      errorCode: "config_error",
      errorCategory: "configuration",
      retryable: false,
      errorMessage: `cannot read models.json: ${redactSensitiveString(error instanceof Error ? error.message : String(error))}`,
    });
  }

  const provider = models?.providers?.[options.provider];
  if (!isObject(provider)) {
    return failure(context, {
      errorCode: "config_error",
      errorCategory: "configuration",
      retryable: false,
      errorMessage: `provider not found in models.json: ${options.provider}`,
    });
  }

  const configuredModel = Array.isArray(provider.models)
    ? provider.models.find((item) => isObject(item) && item.id === options.model)
    : undefined;
  if (!configuredModel) {
    return failure(context, {
      errorCode: "config_error",
      errorCategory: "configuration",
      retryable: false,
      errorMessage: `model not found under provider ${options.provider}: ${options.model}`,
    });
  }

  const baseUrl = normalizeBaseUrl(
    process.env.XTALPI_PI_TOOLS_BASE_URL ||
      process.env.XTALPI_BASE_URL ||
      provider.baseUrl ||
      DEFAULT_BASE_URL,
  );
  const endpoint = `${baseUrl}/chat/completions`;
  const apiKey =
    process.env.XTALPI_PI_TOOLS_API_KEY ||
    process.env.XTALPI_API_KEY ||
    provider.apiKey ||
    "";

  if (isPlaceholderKey(apiKey)) {
    return failure(context, {
      baseUrl,
      endpoint,
      errorCode: "api_key_missing",
      errorCategory: "configuration",
      retryable: false,
      errorMessage: "xtalpi-pi-tools API key is not configured",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`provider health timeout after ${options.timeoutMs}ms`)),
    options.timeoutMs,
  );
  let response;
  let body = "";
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "pi67 xtalpi provider health check" }],
      }),
      signal: controller.signal,
    });
    body = await response.text();
  } catch (error) {
    const message = redactSensitiveString(error instanceof Error ? error.message : String(error));
    const isTimeout = message.includes("timeout after") || (error instanceof Error && error.name === "AbortError");
    return failure(context, {
      baseUrl,
      endpoint,
      errorCode: isTimeout ? "request_timeout" : "network_error",
      errorCategory: isTimeout ? "timeout" : "network",
      retryable: true,
      errorMessage: isTimeout
        ? `xtalpi-pi-tools provider health timeout after ${options.timeoutMs}ms`
        : `xtalpi-pi-tools provider health network error: ${message}`,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return failure(context, {
      baseUrl,
      endpoint,
      httpStatus: response.status,
      ...classifyHttpStatus(response.status),
      errorMessage: `xtalpi-pi-tools provider health HTTP ${response.status}: ${
        redactSensitiveString(body.slice(0, 300) || "(no body)")
      }`,
    });
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return failure(context, {
      baseUrl,
      endpoint,
      errorCode: "non_json_response",
      errorCategory: "protocol",
      retryable: true,
      errorMessage: `xtalpi-pi-tools provider health returned non-JSON response: ${
        redactSensitiveString(error instanceof Error ? error.message : String(error))
      }`,
    });
  }

  if (!Array.isArray(json?.choices)) {
    return failure(context, {
      baseUrl,
      endpoint,
      errorCode: "malformed_response",
      errorCategory: "protocol",
      retryable: true,
      errorMessage: "xtalpi-pi-tools provider health returned JSON without choices[]",
    });
  }

  return success(context, {
    baseUrl,
    endpoint,
    httpStatus: response.status,
    choices: json.choices.length,
    responseModel: typeof json.model === "string" ? json.model : undefined,
  });
}

function selfTest() {
  const redacted = redactSensitiveString("rate limited for Bearer short and sk-testvalue1234567890");
  if (redacted.includes("Bearer short") || redacted.includes("sk-testvalue1234567890")) {
    throw new Error("redaction self-test failed");
  }
  const rateLimit = classifyHttpStatus(429);
  if (rateLimit.errorCode !== "http_429" || rateLimit.errorCategory !== "rate_limit" || rateLimit.retryable !== true) {
    throw new Error("http 429 classification self-test failed");
  }
  const upstream = classifyHttpStatus(503);
  if (upstream.errorCode !== "http_5xx" || upstream.errorCategory !== "upstream" || upstream.retryable !== true) {
    throw new Error("http 5xx classification self-test failed");
  }
  console.log("xtalpi provider health self-test passed");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (args.selfTest) {
    selfTest();
    process.exit(0);
  }
  const result = await checkProviderHealth(args);
  writeResult(result, args.outputFile);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
