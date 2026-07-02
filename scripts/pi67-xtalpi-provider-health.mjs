#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

function usage() {
  console.log(`Usage:
  pi67-xtalpi-provider-health.mjs [options]

Options:
  --agent-dir DIR      Pi agent dir. Defaults to ~/.pi/agent.
  --provider ID        Provider id. Defaults to xtalpi-pi-tools.
  --model ID           Model id. Defaults to deepseek-v4-pro.
  --timeout-ms MS      Request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --attempts N         Max health attempts for retryable transient failures. Defaults to ${DEFAULT_ATTEMPTS}.
  --retry-delay-ms MS  Delay between retryable attempts. Defaults to ${DEFAULT_RETRY_DELAY_MS}.
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
    timeoutMs: DEFAULT_TIMEOUT_MS,
    attempts: DEFAULT_ATTEMPTS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
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
      case "--attempts":
        args.attempts = Number(argv[++index] || "");
        break;
      case "--retry-delay-ms":
        args.retryDelayMs = Number(argv[++index] || "");
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
    if (!Number.isInteger(args.attempts) || args.attempts < 1 || args.attempts > 5) {
      throw new Error("--attempts must be an integer between 1 and 5");
    }
    if (!Number.isInteger(args.retryDelayMs) || args.retryDelayMs < 0) {
      throw new Error("--retry-delay-ms must be a non-negative integer");
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
  return !raw || raw.includes("YOUR_") || raw.includes("REPLACE_") || raw === "changeme" || /^<[^>]+>$/.test(raw);
}

function providerFromModels(models, id) {
  const provider = models?.providers?.[id];
  return isObject(provider) ? provider : undefined;
}

function providersForRuntime(models, providerId) {
  const primary = providerFromModels(models, providerId);
  const providers = [primary];
  if (providerId === "xtalpi-pi-tools") {
    providers.push(providerFromModels(models, "xtalpi-tools"));
    providers.push(providerFromModels(models, "xtalpi"));
  }
  return { primary, providers };
}

function stringField(provider, field) {
  const value = provider?.[field];
  return typeof value === "string" ? value : undefined;
}

function firstStringField(providers, field) {
  for (const provider of providers) {
    const value = stringField(provider, field);
    if (value) return value;
  }
  return undefined;
}

function firstRealProviderKey(providers) {
  for (const provider of providers) {
    const value = stringField(provider, "apiKey");
    if (value && !isPlaceholderKey(value)) return value;
  }
  return undefined;
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

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attemptSummary(result, attempt, startedAt) {
  return {
    attempt,
    ok: result.ok === true,
    elapsedMs: Date.now() - startedAt,
    errorCode: result.errorCode,
    errorCategory: result.errorCategory,
    retryable: result.retryable,
    httpStatus: result.httpStatus,
    choices: result.choices,
    responseModel: result.responseModel,
  };
}

function shouldRetryNow(result) {
  if (result.ok === true || result.retryable !== true) return false;
  // A 429 needs caller-level backoff, not an immediate second health probe.
  return result.errorCode !== "http_429";
}

async function requestProviderHealth(context, request) {
  const { endpoint, apiKey, model, timeoutMs } = request;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`provider health timeout after ${timeoutMs}ms`)),
    timeoutMs,
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
        model,
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
      errorCode: isTimeout ? "request_timeout" : "network_error",
      errorCategory: isTimeout ? "timeout" : "network",
      retryable: true,
      errorMessage: isTimeout
        ? `xtalpi-pi-tools provider health timeout after ${timeoutMs}ms`
        : `xtalpi-pi-tools provider health network error: ${message}`,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return failure(context, {
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
      errorCode: "malformed_response",
      errorCategory: "protocol",
      retryable: true,
      errorMessage: "xtalpi-pi-tools provider health returned JSON without choices[]",
    });
  }

  return success(context, {
    httpStatus: response.status,
    choices: json.choices.length,
    responseModel: typeof json.model === "string" ? json.model : undefined,
  });
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

  const { primary: provider, providers } = providersForRuntime(models, options.provider);
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
      firstStringField(providers, "baseUrl") ||
      DEFAULT_BASE_URL,
  );
  const endpoint = `${baseUrl}/chat/completions`;
  const apiKey =
    process.env.XTALPI_PI_TOOLS_API_KEY ||
    process.env.XTALPI_API_KEY ||
    firstRealProviderKey(providers) ||
    stringField(provider, "apiKey") ||
    "";

  if (isPlaceholderKey(apiKey)) {
    return failure(context, {
      baseUrl,
      endpoint,
      errorCode: "api_key_missing",
      errorCategory: "configuration",
      retryable: false,
      attemptsConfigured: options.attempts,
      retryDelayMs: options.retryDelayMs,
      attemptCount: 0,
      retryCount: 0,
      attempts: [],
      errorMessage: "xtalpi-pi-tools API key is not configured",
    });
  }

  const attempts = [];
  let lastResult;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    lastResult = await requestProviderHealth(context, {
      endpoint,
      apiKey,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
    attempts.push(attemptSummary(lastResult, attempt, attemptStartedAt));

    const commonFields = {
      baseUrl,
      endpoint,
      attemptsConfigured: options.attempts,
      retryDelayMs: options.retryDelayMs,
      attemptCount: attempts.length,
      retryCount: Math.max(0, attempts.length - 1),
      attempts,
    };

    if (lastResult.ok) {
      return success(context, {
        ...commonFields,
        httpStatus: lastResult.httpStatus,
        choices: lastResult.choices,
        responseModel: lastResult.responseModel,
      });
    }

    if (attempt >= options.attempts || !shouldRetryNow(lastResult)) {
      return failure(context, {
        ...commonFields,
        httpStatus: lastResult.httpStatus,
        errorCode: lastResult.errorCode,
        errorCategory: lastResult.errorCategory,
        retryable: lastResult.retryable,
        retrySuppressedReason: lastResult.errorCode === "http_429" ? "rate_limit_immediate_retry_disabled" : undefined,
        errorMessage: lastResult.errorMessage,
      });
    }

    await sleep(options.retryDelayMs);
  }

  return failure(context, {
    baseUrl,
    endpoint,
    attemptsConfigured: options.attempts,
    retryDelayMs: options.retryDelayMs,
    attemptCount: attempts.length,
    retryCount: Math.max(0, attempts.length - 1),
    attempts,
    errorCode: lastResult?.errorCode || "unknown_error",
    errorCategory: lastResult?.errorCategory || "upstream",
    retryable: false,
    errorMessage: lastResult?.errorMessage || "xtalpi-pi-tools provider health failed without a result",
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
  if (shouldRetryNow({ ok: false, retryable: true, errorCode: "http_429" })) {
    throw new Error("http 429 immediate retry suppression self-test failed");
  }
  if (!shouldRetryNow({ ok: false, retryable: true, errorCode: "request_timeout" })) {
    throw new Error("request timeout retry self-test failed");
  }
  if (!isPlaceholderKey("changeme") || !isPlaceholderKey("REPLACE_THIS_KEY")) {
    throw new Error("placeholder key self-test failed");
  }
  const legacyRuntime = providersForRuntime({
    providers: {
      "xtalpi-pi-tools": { apiKey: "YOUR_XTALPI_API_KEY" },
      "xtalpi-tools": { apiKey: "legacy-key-1234567890" },
    },
  }, "xtalpi-pi-tools");
  if (firstRealProviderKey(legacyRuntime.providers) !== "legacy-key-1234567890") {
    throw new Error("legacy xtalpi key fallback self-test failed");
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
