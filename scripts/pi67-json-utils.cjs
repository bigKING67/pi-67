#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function firstBytesHex(buffer, maxBytes = 16) {
  return Array.from(buffer.subarray(0, maxBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function countUtf16NulPattern(buffer) {
  const pairLimit = Math.min(Math.floor(buffer.length / 2), 128);
  let oddNuls = 0;
  let evenNuls = 0;
  for (let pair = 0; pair < pairLimit; pair += 1) {
    if (buffer[pair * 2] === 0) evenNuls += 1;
    if (buffer[pair * 2 + 1] === 0) oddNuls += 1;
  }
  return { pairLimit, oddNuls, evenNuls };
}

function looksUtf16Le(buffer) {
  if (buffer.length < 4) return false;
  const { pairLimit, oddNuls, evenNuls } = countUtf16NulPattern(buffer);
  return pairLimit >= 2 && oddNuls >= Math.ceil(pairLimit * 0.3) && oddNuls > evenNuls * 2;
}

function looksUtf16Be(buffer) {
  if (buffer.length < 4) return false;
  const { pairLimit, oddNuls, evenNuls } = countUtf16NulPattern(buffer);
  return pairLimit >= 2 && evenNuls >= Math.ceil(pairLimit * 0.3) && evenNuls > oddNuls * 2;
}

function decodeUtf16Be(buffer) {
  const usableLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(usableLength);
  for (let i = 0; i < usableLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped.toString("utf16le");
}

function stripLeadingJsonNoise(text) {
  return String(text).replace(/^[\uFEFF\u0000]+/, "");
}

function decodeJsonBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  const hadNulByte = buffer.includes(0);
  let encoding = "utf8";
  let hadBom = false;
  let text;

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    encoding = "utf8-bom";
    hadBom = true;
    text = buffer.subarray(3).toString("utf8");
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le-bom";
    hadBom = true;
    text = buffer.subarray(2).toString("utf16le");
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be-bom";
    hadBom = true;
    text = decodeUtf16Be(buffer.subarray(2));
  } else if (looksUtf16Le(buffer)) {
    encoding = "utf16le";
    text = buffer.toString("utf16le");
  } else if (looksUtf16Be(buffer)) {
    encoding = "utf16be";
    text = decodeUtf16Be(buffer);
  } else {
    text = buffer.toString("utf8");
  }

  const cleaned = stripLeadingJsonNoise(text);
  return {
    text: cleaned,
    encoding,
    hadBom,
    hadNulByte,
    leadingNoiseRemoved: cleaned.length !== text.length,
    firstBytesHex: firstBytesHex(buffer),
    needsNormalization:
      encoding !== "utf8" || hadBom || hadNulByte || cleaned.length !== text.length,
  };
}

function readJsonFile(file) {
  const decoded = decodeJsonBuffer(fs.readFileSync(file));
  try {
    return JSON.parse(decoded.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = `detectedEncoding=${decoded.encoding}; firstBytes=${decoded.firstBytesHex}`;
    throw new Error(`cannot parse JSON ${file}: ${message}; ${details}`);
  }
}

function writeJsonFileUtf8NoBom(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

function normalizeJsonFileInPlace(file, options = {}) {
  const backup = options.backup !== false;
  const buffer = fs.readFileSync(file);
  const decoded = decodeJsonBuffer(buffer);
  let value;
  try {
    value = JSON.parse(decoded.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = `detectedEncoding=${decoded.encoding}; firstBytes=${decoded.firstBytesHex}`;
    throw new Error(`cannot normalize JSON ${file}: ${message}; ${details}`);
  }

  if (!decoded.needsNormalization) {
    return { changed: false, encoding: decoded.encoding, backupFile: "" };
  }

  let backupFile = "";
  if (backup) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    backupFile = `${file}.bak-${stamp}-encoding`;
    fs.copyFileSync(file, backupFile);
  }
  writeJsonFileUtf8NoBom(file, value);
  return { changed: true, encoding: decoded.encoding, backupFile };
}

function runSelfTest() {
  const sample = { probe: true, nested: { value: 67 } };
  const sampleText = JSON.stringify(sample, null, 2);
  const cases = [
    ["utf8", Buffer.from(sampleText, "utf8")],
    ["utf8-bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sampleText, "utf8")])],
    ["utf16le-bom", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sampleText, "utf16le")])],
    ["utf16be-bom", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(sampleText, "utf16le").swap16()])],
    ["utf16le", Buffer.from(sampleText, "utf16le")],
    ["utf16be", Buffer.from(sampleText, "utf16le").swap16()],
    ["leading-nul", Buffer.concat([Buffer.from([0x00]), Buffer.from(sampleText, "utf8")])],
  ];

  for (const [name, buffer] of cases) {
    const decoded = decodeJsonBuffer(buffer);
    const parsed = JSON.parse(decoded.text);
    if (parsed.nested?.value !== 67) {
      throw new Error(`self-test failed for ${name}`);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-json-utils-"));
  try {
    const file = path.join(tmpDir, "models.json");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sampleText, "utf16le")]));
    const result = normalizeJsonFileInPlace(file);
    if (!result.changed || !fs.existsSync(result.backupFile)) {
      throw new Error("normalization self-test did not create backup");
    }
    const normalized = fs.readFileSync(file);
    if (normalized[0] === 0xef || normalized.includes(0)) {
      throw new Error("normalization self-test did not write UTF-8 without BOM/NUL bytes");
    }
    const parsed = readJsonFile(file);
    if (parsed.nested?.value !== 67) {
      throw new Error("normalization self-test changed JSON data");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    console.log("pi67-json-utils self-test passed");
  } else if (args[0] === "--normalize" && args[1]) {
    const result = normalizeJsonFileInPlace(args[1]);
    console.log(JSON.stringify(result, null, 2));
  } else if (args[0] === "--read" && args[1]) {
    console.log(JSON.stringify(readJsonFile(args[1]), null, 2));
  } else {
    console.error("Usage: pi67-json-utils.cjs --self-test | --read FILE | --normalize FILE");
    process.exit(2);
  }
}

module.exports = {
  decodeJsonBuffer,
  firstBytesHex,
  normalizeJsonFileInPlace,
  readJsonFile,
  stripLeadingJsonNoise,
  writeJsonFileUtf8NoBom,
};
