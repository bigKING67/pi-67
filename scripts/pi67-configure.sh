#!/usr/bin/env bash
set -euo pipefail

# Safe local configuration helper for pi-67.
# It keeps the full distribution installed, then fills local-only runtime config
# files from env values, CLI path options, or hidden interactive prompts.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

YES=false
DRY_RUN=false
RUN_DOCTOR=true
PROMPT_SECRETS=auto

REQUESTED_PROVIDER="${PI67_PROVIDER:-}"
REQUESTED_MODEL="${PI67_MODEL:-}"
REQUESTED_CODEX_BASE_URL="${PI67_CODEX_BASE_URL:-}"
REQUESTED_TMWD_REPO="${PI67_TMWD_BROWSER_MCP_REPO:-}"
REQUESTED_AGENT_MEMORY_BIN="${PI67_AGENT_MEMORY_BIN:-}"
REQUESTED_IMAGE_GEN_BASE_URL="${PI67_IMAGE_GEN_BASE_URL:-}"
REQUESTED_IMAGE_GEN_MODEL="${PI67_IMAGE_GEN_MODEL:-}"

usage() {
  cat <<'USAGE'
pi67-configure safely updates local Pi runtime config after full install.

Usage:
  scripts/pi67-configure.sh [options]

Options:
      --repo-root DIR          Repository root. Defaults to parent of this script.
      --agent-dir DIR          Pi agent dir. Defaults to ~/.pi/agent.
      --provider ID            Set local settings.defaultProvider.
      --model ID               Set local settings.defaultModel.
      --codex-base-url URL     Set models.providers.codex.baseUrl and image-gen baseUrl when requested.
      --tmwd-repo DIR          Set browser67 tmwd_browser/js-reverse MCP paths from this repo root.
      --agent-memory-bin FILE  Set agent_memory MCP command path.
      --image-gen-base-url URL Set image-gen.json baseUrl.
      --image-gen-model ID     Set image-gen.json model.
      --prompt-secrets         Ask for missing keys with hidden input.
      --no-prompt              Never ask for secrets or paths; use env/CLI only.
      --dry-run                Print planned changes without writing.
      --no-doctor              Skip pi67-doctor after writing.
  -y, --yes                    Non-interactive; same as --no-prompt.
  -h, --help                   Show this help.

Secret input is intentionally env-based or hidden prompt based. Avoid putting
API keys directly in CLI flags because shell history may persist them.

Supported env vars:
  PI67_PROVIDER
  PI67_MODEL
  PI67_XTALPI_API_KEY
  PI67_XTALPI_PI_TOOLS_API_KEY
  PI67_XTALPI_TOOLS_API_KEY     # legacy alias; migrated to xtalpi-pi-tools
  PI67_KEEP_LEGACY_XTALPI_PROVIDERS=1  # optional escape hatch
  PI67_CODEX_API_KEY
  PI67_CODEX_BASE_URL
  PI67_DEEPSEEK_API_KEY
  PI67_IMAGE_GEN_API_KEY
  PI67_IMAGE_GEN_BASE_URL
  PI67_IMAGE_GEN_MODEL
  PI67_TMWD_BROWSER_MCP_REPO  # legacy env name; value should point to browser67
  PI67_AGENT_MEMORY_BIN
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?--repo-root requires a path}"
      shift 2
      ;;
    --agent-dir)
      PI_AGENT_DIR="${2:?--agent-dir requires a path}"
      shift 2
      ;;
    --provider)
      REQUESTED_PROVIDER="${2:?--provider requires a provider id}"
      shift 2
      ;;
    --model)
      REQUESTED_MODEL="${2:?--model requires a model id}"
      shift 2
      ;;
    --codex-base-url)
      REQUESTED_CODEX_BASE_URL="${2:?--codex-base-url requires a URL}"
      shift 2
      ;;
    --tmwd-repo)
      REQUESTED_TMWD_REPO="${2:?--tmwd-repo requires a directory}"
      shift 2
      ;;
    --agent-memory-bin)
      REQUESTED_AGENT_MEMORY_BIN="${2:?--agent-memory-bin requires a file path}"
      shift 2
      ;;
    --image-gen-base-url)
      REQUESTED_IMAGE_GEN_BASE_URL="${2:?--image-gen-base-url requires a URL}"
      shift 2
      ;;
    --image-gen-model)
      REQUESTED_IMAGE_GEN_MODEL="${2:?--image-gen-model requires a model id}"
      shift 2
      ;;
    --prompt-secrets)
      PROMPT_SECRETS=true
      shift
      ;;
    --no-prompt)
      PROMPT_SECRETS=false
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-doctor)
      RUN_DOCTOR=false
      shift
      ;;
    -y|--yes)
      YES=true
      PROMPT_SECRETS=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option:${NC} $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

say() {
  echo -e "$*"
}

warn() {
  say "  ${YELLOW}WARN${NC} $*"
}

pass() {
  say "  ${GREEN}PASS${NC} $*"
}

prompt_secret() {
  local var_name="$1"
  local label="$2"
  local current="${!var_name:-}"
  local value

  if [ -n "$current" ]; then
    return
  fi

  printf "%b" "  ${CYAN}?${NC} $label (blank to skip): " >&2
  IFS= read -r -s value || true
  printf "\n" >&2

  if [ -n "$value" ]; then
    export "$var_name=$value"
  fi
}

prompt_value() {
  local var_name="$1"
  local label="$2"
  local default_value="$3"
  local current="${!var_name:-}"
  local value
  local prompt_suffix

  if [ -n "$current" ]; then
    return
  fi

  if [ -n "$default_value" ]; then
    prompt_suffix="[$default_value] (blank to use default)"
  else
    prompt_suffix="(blank to skip)"
  fi

  printf "%b" "  ${CYAN}?${NC} $label $prompt_suffix: " >&2
  IFS= read -r value || true
  if [ -z "$value" ]; then
    value="$default_value"
  fi

  if [ -n "$value" ]; then
    export "$var_name=$value"
  fi
}

if [ "$PROMPT_SECRETS" = auto ]; then
  if [ "$YES" = true ] || [ ! -t 0 ]; then
    PROMPT_SECRETS=false
  else
    PROMPT_SECRETS=true
  fi
fi

export PI67_PROVIDER="$REQUESTED_PROVIDER"
export PI67_MODEL="$REQUESTED_MODEL"
export PI67_CODEX_BASE_URL="$REQUESTED_CODEX_BASE_URL"
export PI67_TMWD_BROWSER_MCP_REPO="$REQUESTED_TMWD_REPO"
export PI67_AGENT_MEMORY_BIN="$REQUESTED_AGENT_MEMORY_BIN"
export PI67_IMAGE_GEN_BASE_URL="$REQUESTED_IMAGE_GEN_BASE_URL"
export PI67_IMAGE_GEN_MODEL="$REQUESTED_IMAGE_GEN_MODEL"

say ""
say "${CYAN}pi-67 configure${NC}"
say "Repository : $REPO_ROOT"
say "Agent dir  : $PI_AGENT_DIR"
if [ "$DRY_RUN" = true ]; then
  say "Dry run    : ${YELLOW}yes${NC}"
fi
say ""

if [ "$PROMPT_SECRETS" = true ]; then
  say "${CYAN}--- local inputs ---${NC}"
  prompt_secret PI67_XTALPI_API_KEY "xtalpi API key for xtalpi-pi-tools"
  prompt_secret PI67_XTALPI_PI_TOOLS_API_KEY "xtalpi-pi-tools API key override"
  prompt_secret PI67_CODEX_API_KEY "local Codex proxy API key"
  prompt_secret PI67_DEEPSEEK_API_KEY "DeepSeek auth key"
  prompt_secret PI67_IMAGE_GEN_API_KEY "image generation API key"
  prompt_value PI67_TMWD_BROWSER_MCP_REPO "browser67 repo/package path" ""
  prompt_value PI67_AGENT_MEMORY_BIN "agent-memory MCP binary" "$HOME/.local/bin/agent-memory-mcp"
fi

node - "$REPO_ROOT" "$PI_AGENT_DIR" "$DRY_RUN" <<'NODE'
const fs = require("fs");
const path = require("path");

const [, , repoRoot, agentDir, dryRunValue] = process.argv;
const { normalizeMcpConfig, absolutePath } = require(path.join(repoRoot, "scripts", "pi67-mcp-config-utils.cjs"));
const dryRun = dryRunValue === "true";
const home = process.env.HOME || "";
let failed = false;
let changed = 0;
const colors = {
  PASS: "\x1b[0;32m",
  WARN: "\x1b[1;33m",
  FAIL: "\x1b[0;31m",
  PLAN: "\x1b[0;36m",
};
const reset = "\x1b[0m";

function emit(level, message) {
  console.log(`  ${colors[level] || ""}${level}${reset} ${message}`);
}

function noteChange(message) {
  emit(dryRun ? "PLAN" : "PASS", message);
}

function fail(message) {
  failed = true;
  emit("FAIL", message);
}

function expandHome(value) {
  if (!value) return "";
  return String(value)
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

function compactHome(value) {
  if (!value) return "";
  const normalized = path.resolve(expandHome(value));
  if (home && normalized === home) return "$HOME";
  if (home && normalized.startsWith(`${home}${path.sep}`)) {
    return `$HOME/${normalized.slice(home.length + 1).split(path.sep).join("/")}`;
  }
  return normalized.split(path.sep).join("/");
}

function lstatMaybe(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function readJson(file, fallbackFile) {
  const stat = lstatMaybe(file);
  const source = stat ? file : fallbackFile;
  if (!source || !fs.existsSync(source)) {
    fail(`missing JSON source: ${file}`);
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(source, "utf8"));
    return { data, existed: Boolean(stat), stat };
  } catch (error) {
    fail(`invalid JSON ${source}: ${error.message}`);
    return null;
  }
}

function stableJson(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function saveJson(file, state, options = {}) {
  if (!state) return;

  const next = stableJson(state.data);
  const stat = lstatMaybe(file);
  const previous = stat ? fs.readFileSync(file, "utf8") : "";
  const wasMissing = !stat;

  if (!wasMissing && previous === next) {
    emit("PASS", `unchanged: ${path.relative(agentDir, file) || file}`);
    return;
  }

  changed += 1;
  const label = path.relative(agentDir, file) || file;
  if (dryRun) {
    emit("PLAN", `${wasMissing ? "create" : "update"} ${label}`);
    if (options.detachSymlink && stat?.isSymbolicLink()) {
      emit("WARN", `would detach symlink before writing local ${label}`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (options.detachSymlink && stat?.isSymbolicLink()) {
    fs.unlinkSync(file);
    emit("WARN", `detached symlink before writing local ${label}`);
  }
  fs.writeFileSync(file, next, { mode: options.mode || 0o600 });
  try {
    fs.chmodSync(file, options.mode || 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  emit("PASS", `${wasMissing ? "created" : "updated"} ${label}`);
}

function env(name) {
  return (process.env[name] || "").trim();
}

function setProviderKey(models, providerId, key) {
  if (!key) return;
  const provider = models.providers?.[providerId];
  if (!provider) {
    fail(`provider not found in models.json: ${providerId}`);
    return;
  }
  provider.apiKey = key;
  noteChange(`configure API key for provider ${providerId}`);
}

function setProviderField(models, providerId, field, value) {
  if (!value) return;
  const provider = models.providers?.[providerId];
  if (!provider) {
    fail(`provider not found in models.json: ${providerId}`);
    return;
  }
  provider[field] = value;
  noteChange(`configure ${providerId}.${field}`);
}

function isPlaceholderApiKey(value) {
  return !value || String(value).includes("YOUR_") || String(value).includes("REPLACE_") || String(value) === "changeme";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureProviderFromExample(models, examples, providerId) {
  models.providers = models.providers || {};
  if (models.providers[providerId]) return models.providers[providerId];

  const provider = examples.providers?.[providerId];
  if (!provider) {
    fail(`provider ${providerId} missing from models.example.json`);
    return null;
  }

  models.providers[providerId] = cloneJson(provider);
  noteChange(`add provider ${providerId} from models.example.json`);
  return models.providers[providerId];
}

function firstRealProviderKey(models, providerIds) {
  for (const providerId of providerIds) {
    const key = models.providers?.[providerId]?.apiKey;
    if (!isPlaceholderApiKey(key)) return key;
  }
  return "";
}

function removeProviderIfPresent(models, providerId) {
  if (!models.providers?.[providerId]) return;
  delete models.providers[providerId];
  noteChange(`remove legacy provider ${providerId}`);
}

function migrateXtalpiPiToolsProvider(models, examples) {
  const provider = ensureProviderFromExample(models, examples, "xtalpi-pi-tools");
  if (!provider) return;

  const migratedKey = firstRealProviderKey(models, ["xtalpi-pi-tools", "xtalpi-tools", "xtalpi"]);
  if (isPlaceholderApiKey(provider.apiKey) && migratedKey) {
    provider.apiKey = migratedKey;
    noteChange("migrate xtalpi API key to provider xtalpi-pi-tools");
  }

  const legacyBaseUrl = models.providers?.["xtalpi-tools"]?.baseUrl || models.providers?.xtalpi?.baseUrl;
  if (legacyBaseUrl && provider.baseUrl !== legacyBaseUrl) {
    provider.baseUrl = legacyBaseUrl;
    noteChange("migrate xtalpi baseUrl to provider xtalpi-pi-tools");
  }

  if (env("PI67_KEEP_LEGACY_XTALPI_PROVIDERS") !== "1") {
    removeProviderIfPresent(models, "xtalpi-tools");
    removeProviderIfPresent(models, "xtalpi");
  }
}

const files = {
  settings: path.join(agentDir, "settings.json"),
  models: path.join(agentDir, "models.json"),
  mcp: path.join(agentDir, "mcp.json"),
  auth: path.join(agentDir, "auth.json"),
  imageGen: path.join(agentDir, "image-gen.json"),
};

const examples = {
  settings: path.join(repoRoot, "settings.json"),
  models: path.join(repoRoot, "models.example.json"),
  mcp: path.join(repoRoot, "mcp.example.json"),
  auth: path.join(repoRoot, "auth.example.json"),
  imageGen: path.join(repoRoot, "image-gen.example.json"),
};

const settingsState = readJson(files.settings, examples.settings);
const modelsState = readJson(files.models, examples.models);
const mcpState = readJson(files.mcp, examples.mcp);
const authState = readJson(files.auth, examples.auth);
const imageGenState = readJson(files.imageGen, examples.imageGen);

if (!settingsState || !modelsState || !mcpState || !authState || !imageGenState) {
  process.exit(1);
}

const settings = settingsState.data;
const models = modelsState.data;
const modelExamples = readJson(examples.models, null)?.data || {};
const mcp = mcpState.data;
const auth = authState.data;
const imageGen = imageGenState.data;
let settingsChanged = false;

migrateXtalpiPiToolsProvider(models, modelExamples);

const xtalpiKey = env("PI67_XTALPI_PI_TOOLS_API_KEY") || env("PI67_XTALPI_TOOLS_API_KEY") || env("PI67_XTALPI_API_KEY");
setProviderKey(models, "xtalpi-pi-tools", xtalpiKey);
setProviderKey(models, "codex", env("PI67_CODEX_API_KEY"));
setProviderField(models, "codex", "baseUrl", env("PI67_CODEX_BASE_URL"));

if (env("PI67_DEEPSEEK_API_KEY")) {
  auth.deepseek = auth.deepseek || {};
  auth.deepseek.type = auth.deepseek.type || "api_key";
  auth.deepseek.key = env("PI67_DEEPSEEK_API_KEY");
  noteChange("configure DeepSeek auth key");
}

if (env("PI67_IMAGE_GEN_API_KEY")) {
  imageGen.apiKey = env("PI67_IMAGE_GEN_API_KEY");
  noteChange("configure image-gen API key");
}
if (env("PI67_IMAGE_GEN_BASE_URL")) {
  imageGen.baseUrl = env("PI67_IMAGE_GEN_BASE_URL");
  noteChange("configure image-gen baseUrl");
} else if (env("PI67_CODEX_BASE_URL")) {
  imageGen.baseUrl = env("PI67_CODEX_BASE_URL");
  noteChange("configure image-gen baseUrl from PI67_CODEX_BASE_URL");
}
if (env("PI67_IMAGE_GEN_MODEL")) {
  imageGen.model = env("PI67_IMAGE_GEN_MODEL");
  noteChange("configure image-gen model");
}

if (env("PI67_TMWD_BROWSER_MCP_REPO")) {
  const tmwdRoot = absolutePath(env("PI67_TMWD_BROWSER_MCP_REPO"), { home, baseDir: agentDir });
  mcp.mcpServers = mcp.mcpServers || {};
  mcp.mcpServers.tmwd_browser = mcp.mcpServers.tmwd_browser || {};
  mcp.mcpServers["js-reverse"] = mcp.mcpServers["js-reverse"] || {};
  mcp.mcpServers.tmwd_browser.command = mcp.mcpServers.tmwd_browser.command || "node";
  mcp.mcpServers["js-reverse"].command = mcp.mcpServers["js-reverse"].command || "node";
  mcp.mcpServers.tmwd_browser.cwd = tmwdRoot;
  mcp.mcpServers["js-reverse"].cwd = tmwdRoot;
  mcp.mcpServers.tmwd_browser.args = ["src/mcp/browser/server.mjs"];
  mcp.mcpServers["js-reverse"].args = ["src/mcp/js-reverse/server.mjs"];
  noteChange(`configure browser67 tmwd_browser/js-reverse MCP cwd: ${tmwdRoot}`);
}

if (env("PI67_AGENT_MEMORY_BIN")) {
  mcp.mcpServers = mcp.mcpServers || {};
  mcp.mcpServers.agent_memory = mcp.mcpServers.agent_memory || {};
  mcp.mcpServers.agent_memory.command = absolutePath(env("PI67_AGENT_MEMORY_BIN"), { home, baseDir: agentDir });
  mcp.mcpServers.agent_memory.args = Array.isArray(mcp.mcpServers.agent_memory.args) ? mcp.mcpServers.agent_memory.args : [];
  noteChange(`configure agent_memory MCP command: ${mcp.mcpServers.agent_memory.command}`);
}

const mcpNormalization = normalizeMcpConfig(mcp, { home, agentDir });
for (const change of mcpNormalization.changes) {
  noteChange(`normalize MCP runtime path: ${change}`);
}

if (settings.defaultProvider === "xtalpi-tools" || settings.defaultProvider === "xtalpi") {
  settings.defaultProvider = "xtalpi-pi-tools";
  settings.defaultModel = settings.defaultModel || "deepseek-v4-pro";
  settings.defaultThinkingLevel = "off";
  settingsChanged = true;
  noteChange("migrate default provider to xtalpi-pi-tools");
}

const requestedProvider = env("PI67_PROVIDER");
let requestedModel = env("PI67_MODEL");
if (requestedProvider || requestedModel) {
  const providerId = requestedProvider || settings.defaultProvider;
  const provider = models.providers?.[providerId];
  if (!provider) {
    fail(`requested default provider not found: ${providerId}`);
  } else {
    const providerModels = Array.isArray(provider.models) ? provider.models : [];
    if (!requestedModel) {
      const existingModel = providerModels.find((item) => item.id === settings.defaultModel);
      requestedModel = existingModel?.id || providerModels[0]?.id || "";
      if (requestedModel) {
        emit("WARN", `--provider used without --model; selected ${requestedModel}`);
      }
    }

    const modelExists = providerModels.some((item) => item.id === requestedModel);
    if (!requestedModel || !modelExists) {
      fail(`requested default model ${requestedModel || "(empty)"} not found under provider ${providerId}`);
    } else {
      if (settings.defaultProvider !== providerId || settings.defaultModel !== requestedModel) {
        settings.defaultProvider = providerId;
        settings.defaultModel = requestedModel;
        settingsChanged = true;
        noteChange(`configure default provider/model: ${providerId}/${requestedModel}`);
      } else {
        emit("PASS", `default provider/model already set: ${providerId}/${requestedModel}`);
      }
    }
  }
}

saveJson(files.models, modelsState, { mode: 0o600 });
saveJson(files.mcp, mcpState, { mode: 0o600 });
saveJson(files.auth, authState, { mode: 0o600 });
saveJson(files.imageGen, imageGenState, { mode: 0o600 });

const settingsStat = lstatMaybe(files.settings);
const settingsNeedsLocalWrite = settingsChanged || !settingsStat;
if (settingsNeedsLocalWrite) {
  saveJson(files.settings, settingsState, { mode: 0o644, detachSymlink: true });
} else {
  emit("PASS", "settings.json unchanged");
}

if (changed === 0) {
  emit("PASS", "no local config changes needed");
}

if (failed) {
  process.exit(1);
}
NODE

say ""
say "${CYAN}--- summary ---${NC}"
pass "configuration pass finished"

if [ "$RUN_DOCTOR" != true ]; then
  warn "doctor skipped by --no-doctor"
elif [ "$DRY_RUN" = true ]; then
  warn "doctor skipped during --dry-run"
else
  DOCTOR="$PI_AGENT_DIR/scripts/pi67-doctor.sh"
  if [ ! -f "$DOCTOR" ]; then
    DOCTOR="$REPO_ROOT/scripts/pi67-doctor.sh"
  fi

  if [ -f "$DOCTOR" ]; then
    say ""
    say "${CYAN}--- pi-67 doctor ---${NC}"
    bash "$DOCTOR" --repo-root "$REPO_ROOT" --agent-dir "$PI_AGENT_DIR"
  else
    warn "doctor script not found"
  fi
fi
