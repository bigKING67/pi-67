#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT_SCHEMA = "xtalpi-pi-tools.provider-error-contract.v1";
const VALIDATION_SCHEMA = "xtalpi-pi-tools.provider-error-contract-validation.v1";
const SELF_TEST_SCHEMA = "xtalpi-pi-tools.provider-error-contract-self-test.v1";

function usage() {
  console.log(`Usage:
  pi67-validate-xtalpi-provider-error-contract.mjs [contract-file] [--json]

Options:
  --json        Print machine-readable validation result.
  --self-test   Validate this validator against known-good and known-bad contracts.
  -h, --help    Show this help.
`);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isStringRecord(value) {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string" && item.length > 0);
}

function duplicateStrings(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function defaultContractPath() {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "extensions",
    "xtalpi-pi-tools",
    "provider-error-contract.json",
  );
}

function parseArgs(argv) {
  const args = {
    contractFile: defaultContractPath(),
    json: false,
    selfTest: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--self-test") {
      args.selfTest = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (!args.contractFileExplicit) {
      args.contractFile = arg;
      args.contractFileExplicit = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function error(message, details = {}) {
  return { message, ...details };
}

function classifyHttpStatus(contract, status) {
  const exact = contract.httpStatus[String(status)];
  if (exact) return exact;
  for (const range of contract.httpStatusRanges) {
    if (status >= range.min && status <= range.max) return range.code;
  }
  return "http_error";
}

export function validateProviderErrorContract(contract, file = "(memory)") {
  const errors = [];
  if (!isObject(contract)) {
    return { ok: false, errors: [error("contract root must be an object", { file })] };
  }
  if (contract.schema !== CONTRACT_SCHEMA) {
    errors.push(error("unexpected contract schema", { file, expected: CONTRACT_SCHEMA, actual: contract.schema }));
  }
  if (!isStringArray(contract.requiredCodes)) {
    errors.push(error("contract.requiredCodes must be a non-empty string array", { file }));
  }
  if (!isStringArray(contract.allowedCategories)) {
    errors.push(error("contract.allowedCategories must be a non-empty string array", { file }));
  }
  if (!isStringRecord(contract.requiredHttpStatus)) {
    errors.push(error("contract.requiredHttpStatus must be an object of status-to-code strings", { file }));
  }
  if (!isStringRecord(contract.classificationSamples)) {
    errors.push(error("contract.classificationSamples must be an object of status-to-code strings", { file }));
  }
  if (!isObject(contract.errors)) {
    errors.push(error("contract.errors must be an object", { file }));
  }
  if (!isObject(contract.httpStatus)) {
    errors.push(error("contract.httpStatus must be an object", { file }));
  }
  if (!Array.isArray(contract.httpStatusRanges)) {
    errors.push(error("contract.httpStatusRanges must be an array", { file }));
  }
  if (errors.length > 0) return { ok: false, errors };

  const actualCodes = Object.keys(contract.errors).sort();
  const expectedCodes = [...contract.requiredCodes].sort();
  const missingCodes = expectedCodes.filter((code) => !contract.errors[code]);
  const extraCodes = actualCodes.filter((code) => !contract.requiredCodes.includes(code));
  const duplicateRequiredCodes = duplicateStrings(contract.requiredCodes);
  const duplicateAllowedCategories = duplicateStrings(contract.allowedCategories);
  if (missingCodes.length > 0) errors.push(error("contract is missing expected error codes", { missingCodes }));
  if (extraCodes.length > 0) errors.push(error("contract has unrecognized error codes", { extraCodes }));
  if (duplicateRequiredCodes.length > 0) errors.push(error("contract.requiredCodes has duplicate entries", { duplicateRequiredCodes }));
  if (duplicateAllowedCategories.length > 0) {
    errors.push(error("contract.allowedCategories has duplicate entries", { duplicateAllowedCategories }));
  }

  const allowedCategories = new Set(contract.allowedCategories);

  for (const code of actualCodes) {
    const metadata = contract.errors[code];
    if (!isObject(metadata)) {
      errors.push(error("error metadata must be an object", { code }));
      continue;
    }
    if (!allowedCategories.has(metadata.category)) {
      errors.push(error("invalid error category", { code, category: metadata.category }));
    }
    if (typeof metadata.retryable !== "boolean") {
      errors.push(error("retryable must be boolean", { code }));
    }
    if (typeof metadata.healthImmediateRetry !== "boolean") {
      errors.push(error("healthImmediateRetry must be boolean", { code }));
    }
    if (!["never", "backoff", "retry_after"].includes(metadata.runtimeRetryPolicy)) {
      errors.push(error("runtimeRetryPolicy must be never, backoff, or retry_after", { code }));
    }
    if (metadata.healthImmediateRetry === true && metadata.retryable !== true) {
      errors.push(error("healthImmediateRetry=true requires retryable=true", { code }));
    }
    if (metadata.runtimeRetryPolicy !== "never" && metadata.retryable !== true) {
      errors.push(error("runtime retry requires retryable=true", { code }));
    }
  }

  const rateLimit = contract.errors.http_429;
  if (
    !isObject(rateLimit) ||
    rateLimit.category !== "rate_limit" ||
    rateLimit.retryable !== true ||
    rateLimit.healthImmediateRetry !== false ||
    rateLimit.runtimeRetryPolicy !== "retry_after"
  ) {
    errors.push(error("http_429 must use retry_after without immediate health retry"));
  }

  for (const [status, code] of Object.entries(contract.requiredHttpStatus)) {
    if (contract.httpStatus[status] !== code) {
      errors.push(error("missing or wrong exact HTTP status mapping", { status, expected: code, actual: contract.httpStatus[status] }));
    }
  }
  for (const [status, code] of Object.entries(contract.httpStatus)) {
    if (!/^[0-9]+$/.test(status) || Number(status) < 100 || Number(status) > 599) {
      errors.push(error("HTTP status mapping key must be a 100-599 integer string", { status }));
    }
    if (!contract.errors[code]) {
      errors.push(error("HTTP status maps to an unknown error code", { status, code }));
    }
  }
  for (const [status, code] of Object.entries(contract.requiredHttpStatus)) {
    if (!/^[0-9]+$/.test(status) || Number(status) < 100 || Number(status) > 599) {
      errors.push(error("required HTTP status key must be a 100-599 integer string", { status }));
    }
    if (!contract.errors[code]) {
      errors.push(error("required HTTP status maps to an unknown error code", { status, code }));
    }
  }

  for (const [index, range] of contract.httpStatusRanges.entries()) {
    if (!isObject(range)) {
      errors.push(error("HTTP status range must be an object", { index }));
      continue;
    }
    if (!Number.isInteger(range.min) || !Number.isInteger(range.max)) {
      errors.push(error("HTTP status range bounds must be integers", { index }));
    } else {
      if (range.min < 100 || range.max > 599 || range.min > range.max) {
        errors.push(error("HTTP status range bounds must be ordered within 100-599", { index, min: range.min, max: range.max }));
      }
    }
    if (!contract.errors[range.code]) {
      errors.push(error("HTTP status range maps to an unknown error code", { index, code: range.code }));
    }
  }
  for (let left = 0; left < contract.httpStatusRanges.length; left += 1) {
    const earlier = contract.httpStatusRanges[left];
    if (!isObject(earlier)) continue;
    for (let right = left + 1; right < contract.httpStatusRanges.length; right += 1) {
      const later = contract.httpStatusRanges[right];
      if (!isObject(later)) continue;
      if (earlier.min <= later.min && earlier.max >= later.max && (earlier.min !== later.min || earlier.max !== later.max)) {
        errors.push(error("broader HTTP status range must not appear before a narrower overlapping range", { earlierIndex: left, laterIndex: right }));
      }
    }
  }

  for (const [statusText, expectedCode] of Object.entries(contract.classificationSamples)) {
    const status = Number(statusText);
    if (!/^[0-9]+$/.test(statusText) || status < 100 || status > 599) {
      errors.push(error("classification sample key must be a 100-599 integer string", { status: statusText }));
      continue;
    }
    if (!contract.errors[expectedCode]) {
      errors.push(error("classification sample maps to an unknown error code", { status, expectedCode }));
      continue;
    }
    const actualCode = classifyHttpStatus(contract, status);
    if (actualCode !== expectedCode) {
      errors.push(error("HTTP status sample classified incorrectly", { status, expected: expectedCode, actual: actualCode }));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    codeCount: actualCodes.length,
    httpStatusCount: Object.keys(contract.httpStatus).length,
    httpStatusRangeCount: contract.httpStatusRanges.length,
    immediateRetryCodes: actualCodes.filter((code) => contract.errors[code]?.healthImmediateRetry === true),
  };
}

export function readAndValidateProviderErrorContract(file) {
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  return validateProviderErrorContract(contract, file);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasValidationError(result, message) {
  return result.errors.some((item) => item.message === message);
}

function selfTestCase(name, baseContract, mutate, expectedMessage) {
  const contract = clone(baseContract);
  mutate(contract);
  const result = validateProviderErrorContract(contract, `self-test:${name}`);
  const ok = !result.ok && hasValidationError(result, expectedMessage);
  return {
    name,
    ok,
    expectedMessage,
    actualMessages: result.errors.map((item) => item.message),
  };
}

export function runSelfTest(contractFile = defaultContractPath()) {
  const baseContract = JSON.parse(fs.readFileSync(contractFile, "utf8"));
  const baseResult = validateProviderErrorContract(baseContract, contractFile);
  const cases = [
    {
      name: "current_contract_valid",
      ok: baseResult.ok,
      expectedMessage: null,
      actualMessages: baseResult.errors.map((item) => item.message),
    },
    selfTestCase(
      "missing_required_codes_manifest",
      baseContract,
      (contract) => {
        delete contract.requiredCodes;
      },
      "contract.requiredCodes must be a non-empty string array",
    ),
    selfTestCase(
      "duplicate_required_codes_manifest",
      baseContract,
      (contract) => {
        contract.requiredCodes.push("request_timeout");
      },
      "contract.requiredCodes has duplicate entries",
    ),
    selfTestCase(
      "missing_expected_code",
      baseContract,
      (contract) => {
        delete contract.errors.request_timeout;
      },
      "contract is missing expected error codes",
    ),
    selfTestCase(
      "extra_unrecognized_code",
      baseContract,
      (contract) => {
        contract.errors.extra_transient = {
          category: "network",
          retryable: true,
          healthImmediateRetry: true,
          runtimeRetryPolicy: "backoff",
        };
      },
      "contract has unrecognized error codes",
    ),
    selfTestCase(
      "invalid_category",
      baseContract,
      (contract) => {
        contract.errors.network_error.category = "transient";
      },
      "invalid error category",
    ),
    selfTestCase(
      "non_boolean_retryable",
      baseContract,
      (contract) => {
        contract.errors.http_5xx.retryable = "yes";
      },
      "retryable must be boolean",
    ),
    selfTestCase(
      "immediate_retry_requires_retryable",
      baseContract,
      (contract) => {
        contract.errors.http_401.healthImmediateRetry = true;
      },
      "healthImmediateRetry=true requires retryable=true",
    ),
    selfTestCase(
      "http_429_no_immediate_retry",
      baseContract,
      (contract) => {
        contract.errors.http_429.healthImmediateRetry = true;
      },
      "http_429 must use retry_after without immediate health retry",
    ),
    selfTestCase(
      "wrong_exact_http_status",
      baseContract,
      (contract) => {
        contract.httpStatus["429"] = "http_error";
      },
      "missing or wrong exact HTTP status mapping",
    ),
    selfTestCase(
      "unknown_http_status_code",
      baseContract,
      (contract) => {
        contract.httpStatus["418"] = "teapot";
      },
      "HTTP status maps to an unknown error code",
    ),
    selfTestCase(
      "invalid_http_range_bounds",
      baseContract,
      (contract) => {
        contract.httpStatusRanges[0] = {
          min: 600,
          max: 599,
          code: "http_5xx",
        };
      },
      "HTTP status range bounds must be ordered within 100-599",
    ),
    selfTestCase(
      "broader_range_before_narrower_range",
      baseContract,
      (contract) => {
        contract.httpStatusRanges = [
          {
            min: 400,
            max: 599,
            code: "http_error",
          },
          {
            min: 500,
            max: 599,
            code: "http_5xx",
          },
        ];
      },
      "broader HTTP status range must not appear before a narrower overlapping range",
    ),
    selfTestCase(
      "classification_sample_drift",
      baseContract,
      (contract) => {
        contract.httpStatusRanges = [
          {
            min: 500,
            max: 599,
            code: "http_error",
          },
        ];
      },
      "HTTP status sample classified incorrectly",
    ),
  ];

  return {
    ok: cases.every((item) => item.ok),
    file: contractFile,
    cases,
  };
}

function printJson(result, file) {
  console.log(JSON.stringify({
    schema: VALIDATION_SCHEMA,
    file,
    ...result,
  }, null, 2));
}

function printText(result, file) {
  if (result.ok) {
    console.log(
      `xtalpi provider error contract valid: ${file} ` +
        `(codes=${result.codeCount}, httpStatus=${result.httpStatusCount}, ranges=${result.httpStatusRangeCount})`,
    );
    return;
  }
  console.error(`xtalpi provider error contract invalid: ${file}`);
  for (const item of result.errors) {
    console.error(`- ${item.message}: ${JSON.stringify(item)}`);
  }
}

function printSelfTestJson(result) {
  console.log(JSON.stringify({
    schema: SELF_TEST_SCHEMA,
    ...result,
  }, null, 2));
}

function printSelfTestText(result) {
  if (result.ok) {
    console.log(`xtalpi provider error contract validator self-test passed: ${result.file} (cases=${result.cases.length})`);
    return;
  }
  console.error(`xtalpi provider error contract validator self-test failed: ${result.file}`);
  for (const item of result.cases.filter((testCase) => !testCase.ok)) {
    console.error(`- ${item.name}: expected ${item.expectedMessage || "valid contract"}, got ${JSON.stringify(item.actualMessages)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }
  if (args.selfTest) {
    const result = runSelfTest(args.contractFile);
    if (args.json) {
      printSelfTestJson(result);
    } else {
      printSelfTestText(result);
    }
    return result.ok ? 0 : 1;
  }
  const result = readAndValidateProviderErrorContract(args.contractFile);
  if (args.json) {
    printJson(result, args.contractFile);
  } else {
    printText(result, args.contractFile);
  }
  return result.ok ? 0 : 1;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === invokedModuleUrl) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
