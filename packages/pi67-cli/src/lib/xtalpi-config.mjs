import fs from "node:fs";
import path from "node:path";

export const XTALPI_PROVIDER_ID = "xtalpi-pi-tools";
export const XTALPI_DEFAULT_MODEL = "deepseek-v4-pro";

export function configureXtalpiModels(options) {
  const agentDir = path.resolve(options.agentDir);
  const repoRoot = path.resolve(options.repoRoot);
  const modelsFile = path.join(agentDir, "models.json");
  const exampleFile = path.join(repoRoot, "models.example.json");
  const current = readJsonDocument(modelsFile, { fallbackFile: exampleFile });
  const example = readJsonDocument(exampleFile);
  const models = cloneJson(current.value);
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new Error(`models JSON root must be an object: ${current.source}`);
  }
  if (!example.value || typeof example.value !== "object" || Array.isArray(example.value)) {
    throw new Error(`models example JSON root must be an object: ${exampleFile}`);
  }
  const exampleProvider = example.value?.providers?.[XTALPI_PROVIDER_ID];
  if (!exampleProvider || typeof exampleProvider !== "object" || Array.isArray(exampleProvider)) {
    throw new Error(`${XTALPI_PROVIDER_ID} is missing from ${exampleFile}`);
  }

  const changes = [];
  if (models.providers == null) {
    models.providers = {};
    changes.push("create providers object");
  } else if (typeof models.providers !== "object" || Array.isArray(models.providers)) {
    throw new Error(`models.json providers must be an object: ${modelsFile}`);
  }

  if (!models.providers[XTALPI_PROVIDER_ID]) {
    models.providers[XTALPI_PROVIDER_ID] = cloneJson(exampleProvider);
    changes.push(`add provider ${XTALPI_PROVIDER_ID} from models.example.json`);
  } else {
    repairProviderContract(models.providers[XTALPI_PROVIDER_ID], exampleProvider, changes);
  }

  const provider = models.providers[XTALPI_PROVIDER_ID];
  validateProviderContract(provider, exampleProvider, modelsFile);

  const suppliedKey = normalizeApiKey(options.apiKey);
  if (suppliedKey) {
    if (provider.apiKey !== suppliedKey) {
      provider.apiKey = suppliedKey;
      changes.push(`configure API key for provider ${XTALPI_PROVIDER_ID}`);
    }
  } else if (isPlaceholderApiKey(provider.apiKey) && !options.allowMissingKey) {
    throw new Error(
      `no usable ${XTALPI_PROVIDER_ID} API key is configured; rerun interactively or set PI67_XTALPI_API_KEY`,
    );
  }

  if (current.needsNormalization) {
    changes.push(`normalize models.json from ${current.encoding} to UTF-8 without BOM`);
  }

  const changed = changes.length > 0 || !current.existed;
  let backupPath = "";
  if (changed && !options.dryRun) {
    if (current.existed && current.needsNormalization) {
      backupPath = encodingBackupPath(modelsFile, options.now);
      fs.copyFileSync(modelsFile, backupPath);
      try {
        fs.chmodSync(backupPath, 0o600);
      } catch {
        // Windows and some filesystems do not expose POSIX modes.
      }
    }
    writeJsonSecure(modelsFile, models);
  }

  return {
    provider: XTALPI_PROVIDER_ID,
    model: XTALPI_DEFAULT_MODEL,
    modelsFile,
    existed: current.existed,
    encoding: current.encoding,
    normalized: current.needsNormalization,
    backupPath,
    changed,
    changes,
    configured: !isPlaceholderApiKey(provider.apiKey),
  };
}

export function validateXtalpiProviderContract(provider, exampleProvider, source = "models.json") {
  validateProviderContract(provider, exampleProvider, source);
  return true;
}

export function isPlaceholderApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return true;
  const normalized = key.toLowerCase();
  return (
    normalized.includes("your_") ||
    normalized.includes("replace_") ||
    normalized.includes("placeholder") ||
    normalized === "changeme"
  );
}

export function decodeJsonDocument(buffer, source = "JSON file") {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("decodeJsonDocument requires a Buffer");
  let encoding = "utf8";
  let hadBom = false;
  let text;

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le-bom";
    hadBom = true;
    text = buffer.subarray(2).toString("utf16le");
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be-bom";
    hadBom = true;
    text = swapUtf16Bytes(buffer.subarray(2)).toString("utf16le");
  } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    encoding = "utf8-bom";
    hadBom = true;
    text = buffer.subarray(3).toString("utf8");
  } else {
    const inferred = inferUtf16Encoding(buffer);
    if (inferred === "utf16le") {
      encoding = "utf16le";
      text = buffer.toString("utf16le");
    } else if (inferred === "utf16be") {
      encoding = "utf16be";
      text = swapUtf16Bytes(buffer).toString("utf16le");
    } else {
      text = buffer.toString("utf8");
    }
  }

  const withoutLeadingNoise = text.replace(/^\uFEFF/, "").replace(/^\0+/, "");
  const leadingNoiseRemoved = withoutLeadingNoise !== text;
  let value;
  try {
    value = JSON.parse(withoutLeadingNoise);
  } catch (error) {
    throw new Error(`invalid JSON ${source}: ${error.message}`);
  }
  return {
    value,
    text: withoutLeadingNoise,
    encoding,
    needsNormalization: encoding !== "utf8" || hadBom || leadingNoiseRemoved,
  };
}

function readJsonDocument(file, options = {}) {
  const existed = fs.existsSync(file);
  const source = existed ? file : options.fallbackFile;
  if (!source || !fs.existsSync(source)) {
    throw new Error(`missing JSON source: ${file}`);
  }
  const decoded = decodeJsonDocument(fs.readFileSync(source), source);
  return {
    ...decoded,
    source,
    existed,
    needsNormalization: existed && decoded.needsNormalization,
  };
}

function validateProviderContract(provider, exampleProvider, source) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`${source} provider ${XTALPI_PROVIDER_ID} must be an object`);
  }
  if (provider.apiKey != null && typeof provider.apiKey !== "string") {
    throw new Error(`${source} provider ${XTALPI_PROVIDER_ID}.apiKey must be a string`);
  }
  if (provider.baseUrl !== exampleProvider.baseUrl) {
    throw new Error(
      `${source} provider ${XTALPI_PROVIDER_ID}.baseUrl is not canonical; run pi-67 update --repair and retry`,
    );
  }
  if (provider.api !== exampleProvider.api) {
    throw new Error(
      `${source} provider ${XTALPI_PROVIDER_ID}.api is not canonical; run pi-67 update --repair and retry`,
    );
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (!models.some((model) => model && model.id === XTALPI_DEFAULT_MODEL)) {
    throw new Error(
      `${source} provider ${XTALPI_PROVIDER_ID} is missing model ${XTALPI_DEFAULT_MODEL}; run pi-67 update --repair and retry`,
    );
  }
}

function repairProviderContract(provider, exampleProvider, changes) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`${XTALPI_PROVIDER_ID} provider must be an object`);
  }

  if (provider.baseUrl !== exampleProvider.baseUrl) {
    provider.baseUrl = exampleProvider.baseUrl;
    changes.push(`repair ${XTALPI_PROVIDER_ID}.baseUrl from the canonical template`);
  }
  if (provider.api !== exampleProvider.api) {
    provider.api = exampleProvider.api;
    changes.push(`repair ${XTALPI_PROVIDER_ID}.api from the canonical template`);
  }

  const currentModels = Array.isArray(provider.models) ? provider.models : [];
  const canonicalModels = Array.isArray(exampleProvider.models) ? exampleProvider.models : [];
  const currentById = new Map(
    currentModels
      .filter((model) => model && typeof model === "object" && typeof model.id === "string")
      .map((model) => [model.id, model]),
  );
  const canonicalIds = new Set(canonicalModels.map((model) => model?.id).filter(Boolean));
  const mergedModels = canonicalModels.map((canonical) => ({
    ...(currentById.get(canonical.id) || {}),
    ...cloneJson(canonical),
  }));
  for (const model of currentModels) {
    if (!canonicalIds.has(model?.id)) mergedModels.push(cloneJson(model));
  }
  if (JSON.stringify(mergedModels) !== JSON.stringify(currentModels)) {
    provider.models = mergedModels;
    changes.push(`synchronize canonical ${XTALPI_PROVIDER_ID} model definitions`);
  }
}

function normalizeApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (isPlaceholderApiKey(key)) throw new Error("refusing to store a placeholder xtalpi API key");
  return key;
}

function writeJsonSecure(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    replaceFileSafely(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows and some filesystems do not expose POSIX modes.
    }
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function replaceFileSafely(source, target, options = {}) {
  const rename = options.renameSync || fs.renameSync;
  try {
    rename(source, target);
    return { usedWindowsFallback: false, rollbackPath: "" };
  } catch (error) {
    if (!fs.existsSync(target) || !isWindowsReplaceError(error)) throw error;
  }

  const rollbackPath = replacementRollbackPath(target);
  fs.renameSync(target, rollbackPath);
  try {
    fs.renameSync(source, target);
  } catch (error) {
    try {
      if (!fs.existsSync(target) && fs.existsSync(rollbackPath)) {
        fs.renameSync(rollbackPath, target);
      }
    } catch (rollbackError) {
      throw new Error(
        `failed to replace ${target} and failed to restore its rollback file ${rollbackPath}: ${rollbackError.message}`,
        { cause: error },
      );
    }
    throw error;
  }

  fs.rmSync(rollbackPath, { force: true });
  if (fs.existsSync(rollbackPath)) {
    throw new Error(`replaced ${target}, but could not remove transient rollback file: ${rollbackPath}`);
  }
  return { usedWindowsFallback: true, rollbackPath };
}

function isWindowsReplaceError(error) {
  return ["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code);
}

function replacementRollbackPath(file) {
  const base = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.replace-backup`);
  if (!fs.existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate replacement rollback path for ${file}`);
}

function encodingBackupPath(file, now = new Date()) {
  const stamp = timestamp(now);
  const base = `${file}.bak-${stamp}-encoding`;
  if (!fs.existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate encoding backup path for ${file}`);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function inferUtf16Encoding(buffer) {
  const sampleLength = Math.min(buffer.length - (buffer.length % 2), 256);
  if (sampleLength < 4) return "";
  let evenNul = 0;
  let oddNul = 0;
  const pairs = sampleLength / 2;
  for (let index = 0; index < sampleLength; index += 2) {
    if (buffer[index] === 0) evenNul += 1;
    if (buffer[index + 1] === 0) oddNul += 1;
  }
  if (oddNul / pairs > 0.3 && evenNul / pairs < 0.1) return "utf16le";
  if (evenNul / pairs > 0.3 && oddNul / pairs < 0.1) return "utf16be";
  return "";
}

function swapUtf16Bytes(buffer) {
  if (buffer.length % 2 !== 0) throw new Error("invalid odd-length UTF-16 JSON input");
  const swapped = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
