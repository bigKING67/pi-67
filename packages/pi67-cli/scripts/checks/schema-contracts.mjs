import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export function validateSchemaPairs(pairs) {
  const Ajv2020 = loadAjv2020();
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const results = [];

  for (const pair of pairs) {
    const schema = readJson(pair.schemaPath);
    const data = readJson(pair.dataPath);
    if (!ajv.validateSchema(schema)) {
      throw new Error(`invalid JSON Schema ${pair.schemaPath}: ${formatErrors(ajv.errors)}`);
    }
    const validate = ajv.compile(schema);
    const valid = validate(data);
    results.push({
      schemaPath: pair.schemaPath,
      dataPath: pair.dataPath,
      valid,
      errors: valid ? [] : normalizeErrors(validate.errors),
    });
  }

  return results;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadAjv2020() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../../npm/package.json"),
    path.resolve(here, "../../package.json"),
  ];
  const errors = [];
  for (const packageFile of candidates) {
    try {
      const required = createRequire(packageFile)("ajv/dist/2020");
      return required.default || required;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`Ajv 2020 is required for schema contracts; run the repository dependency install (${errors.join("; ")})`);
}

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

function formatErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message || error.keyword}`).join("; ");
}

function parseArgs(argv) {
  let json = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return { help: true, json, pairs: [] };
    else positional.push(arg);
  }
  if (positional.length === 0 || positional.length % 2 !== 0) {
    throw new Error("expected one or more <schema.json> <payload.json> pairs");
  }
  const pairs = [];
  for (let index = 0; index < positional.length; index += 2) {
    pairs.push({
      schemaPath: path.resolve(positional[index]),
      dataPath: path.resolve(positional[index + 1]),
    });
  }
  return { help: false, json, pairs };
}

function printHelp() {
  process.stdout.write(`pi-67 schema contracts

Usage:
  node packages/pi67-cli/scripts/checks/schema-contracts.mjs \\
    <schema.json> <payload.json> [<schema.json> <payload.json> ...] [--json]

Every schema is checked as Draft 2020-12 and then compiled before its real
payload is validated. Missing Ajv, invalid schemas, and invalid payloads fail.
`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) return printHelp();
  const results = validateSchemaPairs(options.pairs);
  const failures = results.filter((result) => !result.valid);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      schema: "pi67.schema-contracts.v1",
      valid: failures.length === 0,
      results,
    }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const label = `${path.basename(result.schemaPath)} <- ${path.basename(result.dataPath)}`;
      if (result.valid) process.stdout.write(`PASS ${label}\n`);
      else process.stderr.write(`FAIL ${label}: ${formatErrors(result.errors)}\n`);
    }
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
