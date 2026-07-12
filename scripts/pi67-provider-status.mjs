#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  decodeJsonDocument,
  isPlaceholderApiKey,
  XTALPI_PROVIDER_ID,
} from "../packages/pi67-cli/src/lib/xtalpi-config.mjs";

const DEEPSEEK_PROVIDER_ID = "deepseek";
const options = parseArgs(process.argv.slice(2));
const agentDir = path.resolve(
  options.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(homePath(), ".pi", "agent"),
);
const repoRoot = path.resolve(options.repoRoot || agentDir);

try {
  const settings = readRequiredJson(
    path.join(agentDir, "settings.json"),
    path.join(repoRoot, "settings.json"),
    "settings",
  );
  const models = readRequiredJson(
    path.join(agentDir, "models.json"),
    path.join(repoRoot, "models.example.json"),
    "models",
  );
  const auth = readOptionalJson(path.join(agentDir, "auth.json"), "auth");
  const state = inspectActiveProvider({ settings, models, auth, env: process.env });
  const payload = {
    schema: "pi67-provider-status/v1",
    provider: state.provider,
    model: state.model,
    ready: state.modelRequestReady,
    piStartupReady: true,
    modelRequestReady: state.modelRequestReady,
    kind: state.kind,
    credentialConfigured: state.credentialConfigured,
    credentialSource: state.credentialSource,
    persistenceOwner: "upstream-pi",
    checks: state.checks,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const check of payload.checks) process.stdout.write(`${check.level}|${check.message}\n`);
  }
} catch (error) {
  const message = compact(error?.message || error);
  const payload = {
    schema: "pi67-provider-status/v1",
    provider: "",
    model: "",
    ready: false,
    piStartupReady: false,
    modelRequestReady: false,
    kind: "unknown",
    credentialConfigured: false,
    credentialSource: "not inspected",
    persistenceOwner: "upstream-pi",
    checks: [{ level: "FAIL", message }],
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`FAIL|${message}\n`);
  process.exitCode = 1;
}

function inspectActiveProvider({ settings, models, auth, env }) {
  const provider = String(settings.defaultProvider || "").trim();
  const model = String(settings.defaultModel || "").trim();
  const checks = [];
  const emit = (level, message) => checks.push({ level, message });

  if (!provider) {
    emit("WARN", "no default provider is selected; Pi can still start, then /login and /model can configure one");
    return emptyState(provider, model, "none", checks);
  }
  if (!model) {
    emit("WARN", `provider ${provider} has no selected model; Pi can still start and /model can select one`);
    return emptyState(provider, model, providerKind(provider, models), checks);
  }

  if (provider === DEEPSEEK_PROVIDER_ID) {
    const credential = inspectApiKeyCredential({
      authEntry: auth[provider],
      envNames: ["DEEPSEEK_API_KEY"],
      configuredValue: "",
      env,
    });
    emit("PASS", `upstream Pi owns the selected provider/model: ${provider}/${model}`);
    emitCredentialCheck(emit, provider, credential);
    return stateFromCredential(provider, model, "builtin", credential, checks);
  }

  const custom = models.providers?.[provider];
  if (custom && typeof custom === "object" && !Array.isArray(custom)) {
    const modelExists = Array.isArray(custom.models) && custom.models.some((item) => item?.id === model);
    if (modelExists) emit("PASS", `selected custom provider/model exists: ${provider}/${model}`);
    else emit("WARN", `selected model ${model} is not declared under ${provider}; Pi can still start and /model can replace it`);

    const envNames = provider === XTALPI_PROVIDER_ID
      ? ["XTALPI_PI_TOOLS_API_KEY", "XTALPI_API_KEY"]
      : [];
    const credential = inspectApiKeyCredential({
      authEntry: auth[provider],
      envNames,
      configuredValue: custom.apiKey,
      env,
    });
    emitCredentialCheck(emit, provider, credential);
    return {
      provider,
      model,
      kind: "custom",
      credentialConfigured: credential.configured,
      credentialSource: credential.source,
      modelRequestReady: modelExists && credential.configured,
      checks,
    };
  }

  emit("PASS", `upstream Pi owns the selected provider/model: ${provider}/${model}`);
  emit(
    "WARN",
    `pi-67 does not inspect credentials for upstream provider ${provider}; it will not rewrite the selection, and Pi can still start`,
  );
  return {
    provider,
    model,
    kind: "upstream",
    credentialConfigured: false,
    credentialSource: "managed by upstream Pi",
    modelRequestReady: false,
    checks,
  };
}

function inspectApiKeyCredential({ authEntry, envNames, configuredValue, env }) {
  if (authEntry !== undefined && authEntry !== null) {
    if (authEntry && typeof authEntry === "object" && !Array.isArray(authEntry)) {
      const key = String(authEntry.key || "").trim();
      if (authEntry.type === "api_key" && !isPlaceholderApiKey(key)) {
        return { configured: true, source: "auth.json", invalid: false };
      }
      if (!isPlaceholderApiKey(key) && authEntry.type !== "api_key") {
        return { configured: false, source: "auth.json", invalid: true };
      }
    } else {
      return { configured: false, source: "auth.json", invalid: true };
    }
  }

  for (const name of envNames) {
    if (!isPlaceholderApiKey(env[name])) return { configured: true, source: name, invalid: false };
  }

  const value = String(configuredValue || "").trim();
  if (isPlaceholderApiKey(value)) return { configured: false, source: "not configured", invalid: false };
  const reference = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (reference) {
    const name = reference[1] || reference[2];
    return !isPlaceholderApiKey(env[name])
      ? { configured: true, source: name, invalid: false }
      : { configured: false, source: "not configured", invalid: false };
  }
  if (value.startsWith("!")) return { configured: true, source: "models.json command", invalid: false };
  return { configured: true, source: "models.json", invalid: false };
}

function emitCredentialCheck(emit, provider, credential) {
  if (credential.configured) {
    emit("PASS", `provider ${provider} credential is available via ${credential.source}`);
  } else if (credential.invalid) {
    emit(
      "WARN",
      `provider ${provider} credential configuration is invalid; Pi startup is still available and /login can replace it`,
    );
  } else {
    emit(
      "WARN",
      `provider ${provider} credential is not configured; Pi can still start, then /login can configure it`,
    );
  }
}

function stateFromCredential(provider, model, kind, credential, checks) {
  return {
    provider,
    model,
    kind,
    credentialConfigured: credential.configured,
    credentialSource: credential.source,
    modelRequestReady: credential.configured,
    checks,
  };
}

function emptyState(provider, model, kind, checks) {
  return {
    provider,
    model,
    kind,
    credentialConfigured: false,
    credentialSource: "not configured",
    modelRequestReady: false,
    checks,
  };
}

function providerKind(provider, models) {
  return models.providers?.[provider] ? "custom" : "upstream";
}

function readRequiredJson(primary, fallback, label) {
  const file = fs.existsSync(primary) ? primary : fallback;
  if (!file || !fs.existsSync(file)) throw new Error(`missing ${label} JSON: ${primary}`);
  return readJson(file, label);
}

function readOptionalJson(file, label) {
  if (!fs.existsSync(file)) return {};
  return readJson(file, label);
}

function readJson(file, label) {
  const decoded = decodeJsonDocument(fs.readFileSync(file), file);
  if (!decoded.value || typeof decoded.value !== "object" || Array.isArray(decoded.value)) {
    throw new Error(`${label} JSON root must be an object: ${file}`);
  }
  return decoded.value;
}

function parseArgs(argv) {
  const parsed = { agentDir: "", repoRoot: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--agent-dir" || arg === "--repo-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      parsed[arg === "--agent-dir" ? "agentDir" : "repoRoot"] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return parsed;
}

function homePath() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function compact(value, max = 500) {
  let text = String(value || "");
  for (const secret of [
    process.env.XTALPI_PI_TOOLS_API_KEY,
    process.env.XTALPI_API_KEY,
    process.env.DEEPSEEK_API_KEY,
  ]) {
    if (secret) text = text.split(String(secret)).join("[REDACTED]");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
