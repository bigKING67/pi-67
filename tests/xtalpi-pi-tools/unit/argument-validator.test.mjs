import assert from "node:assert/strict";
import test from "node:test";

import { validateToolArguments } from "../../../extensions/xtalpi-pi-tools/argument-validator.ts";

function validate(parameters, argumentsObject, maxErrors = 8, maxWarnings = 8) {
  return validateToolArguments(
    { name: "test_tool", description: "Argument validator fixture", parameters },
    argumentsObject,
    maxErrors,
    maxWarnings,
  );
}

function errorText(result) {
  assert.equal(result.ok, false);
  return result.errors.join("\n");
}

test("missing tools and non-object parameter schemas pass through", () => {
  assert.deepEqual(validateToolArguments(undefined, {}), { ok: true, warnings: [] });
  assert.deepEqual(validateToolArguments({ name: "none" }, {}), { ok: true, warnings: [] });
  assert.deepEqual(validateToolArguments({ name: "array", parameters: [] }, {}), { ok: true, warnings: [] });
});

test("primitive and union schema types distinguish valid JSON values", () => {
  const cases = [
    { type: "array", valid: [], invalid: "array" },
    { type: "boolean", valid: false, invalid: 0 },
    { type: "integer", valid: 2, invalid: 2.5 },
    { type: "null", valid: null, invalid: "null" },
    { type: "number", valid: 2.5, invalid: Number.POSITIVE_INFINITY },
    { type: "object", valid: { nested: true }, invalid: [] },
    { type: "string", valid: "value", invalid: 1 },
  ];

  for (const { type, valid, invalid } of cases) {
    assert.equal(validate({ type: "object", properties: { value: { type } } }, { value: valid }).ok, true, type);
    assert.match(
      errorText(validate({ type: "object", properties: { value: { type } } }, { value: invalid })),
      new RegExp(`arguments\\.value expected ${type}`),
      type,
    );
  }

  assert.equal(
    validate({ type: "object", properties: { value: { type: ["string", "null", 7] } } }, { value: null }).ok,
    true,
  );
  assert.match(
    errorText(validate(
      { type: "object", properties: { value: { type: ["string", "null", 7] } } },
      { value: true },
    )),
    /arguments\.value expected string\|null, got boolean/,
  );
  assert.equal(validate({ type: "object", properties: { value: { type: "future-type" } } }, { value: true }).ok, true);
});

test("numeric constraints support inclusive, exclusive, and multiple-of forms", () => {
  const parameters = {
    type: "object",
    properties: {
      exclusiveMinNumber: { type: "number", exclusiveMinimum: 2 },
      inclusiveMin: { type: "number", minimum: 1 },
      exclusiveMinBoolean: { type: "number", minimum: 1, exclusiveMinimum: true },
      exclusiveMaxNumber: { type: "number", exclusiveMaximum: 3 },
      inclusiveMax: { type: "number", maximum: 3 },
      exclusiveMaxBoolean: { type: "number", maximum: 3, exclusiveMaximum: true },
      multiple: { type: "number", multipleOf: 2 },
    },
  };
  const errors = errorText(validate(parameters, {
    exclusiveMinNumber: 2,
    inclusiveMin: 0,
    exclusiveMinBoolean: 1,
    exclusiveMaxNumber: 3,
    inclusiveMax: 4,
    exclusiveMaxBoolean: 3,
    multiple: 5,
  }));

  assert.match(errors, /exclusiveMinNumber must be > 2/);
  assert.match(errors, /inclusiveMin must be >= 1/);
  assert.match(errors, /exclusiveMinBoolean must be > 1/);
  assert.match(errors, /exclusiveMaxNumber must be < 3/);
  assert.match(errors, /inclusiveMax must be <= 3/);
  assert.match(errors, /exclusiveMaxBoolean must be < 3/);
  assert.match(errors, /multiple must be a multiple of 2/);

  assert.equal(validate({
    type: "object",
    properties: {
      minimum: { type: "number", minimum: 1 },
      maximum: { type: "number", maximum: 3 },
      multiple: { type: "number", multipleOf: 0 },
      ignored: { type: "number", minimum: Number.NaN },
    },
  }, { minimum: 1, maximum: 3, multiple: 7, ignored: 1 }).ok, true);
});

test("string constraints report length and safe pattern mismatches", () => {
  const errors = errorText(validate({
    type: "object",
    properties: {
      short: { type: "string", minLength: 3 },
      long: { type: "string", maxLength: 3 },
      pattern: { type: "string", pattern: "^package\\.json$" },
    },
  }, { short: "x", long: "xxxx", pattern: "README.md" }));

  assert.match(errors, /arguments\.short length must be >= 3/);
  assert.match(errors, /arguments\.long length must be <= 3/);
  assert.match(errors, /arguments\.pattern must match pattern \^package\\\.json\$/);
  assert.equal(validate(
    { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } },
    { value: "ok" },
  ).ok, true);
});

test("unsafe patterns are skipped with bounded metadata-only warnings", () => {
  const result = validate({
    type: "object",
    properties: {
      tooLong: { type: "string", pattern: "a".repeat(257) },
      nested: { type: "string", pattern: "^(a+)+$" },
      input: { type: "string", pattern: "^a+$" },
      invalid: { type: "string", pattern: "[" },
    },
  }, {
    tooLong: "a",
    nested: "aaaa!",
    input: "a".repeat(1025),
    invalid: "ok",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "pattern_too_long",
    "pattern_nested_quantifier",
    "pattern_input_too_long",
    "pattern_invalid_regex",
  ]);
  assert.deepEqual(result.warnings.map((warning) => warning.path), [
    "arguments.tooLong",
    "arguments.nested",
    "arguments.input",
    "arguments.invalid",
  ]);
  assert.equal(JSON.stringify(result.warnings).includes("^(a+)+$"), false);

  const capped = validate({
    type: "object",
    properties: {
      first: { type: "string", pattern: "[" },
      second: { type: "string", pattern: "[" },
    },
  }, { first: "a", second: "b" }, 8, 1);
  assert.equal(capped.warnings.length, 1);
  assert.equal(validate(
    { type: "object", properties: { value: { type: "string", pattern: "[" } } },
    { value: "a" },
    8,
    0,
  ).warnings.length, 0);
});

test("array constraints validate cardinality and nested item paths", () => {
  const schema = {
    type: "object",
    properties: {
      values: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string", minLength: 1 },
      },
    },
  };

  assert.match(errorText(validate(schema, { values: [] })), /arguments\.values must contain at least 1 item/);
  assert.match(errorText(validate(schema, { values: ["a", "b", "c"] })), /arguments\.values must contain at most 2 item/);
  assert.match(errorText(validate(schema, { values: ["", "ok"] })), /arguments\.values\[0\] length must be >= 1/);
  assert.equal(validate(schema, { values: ["a", "b"] }).ok, true);

  assert.match(
    errorText(validate(
      { type: "object", properties: { values: { type: "array", maxItems: 1 } } },
      { values: [1, 2] },
    )),
    /arguments\.values must contain at most 1 item/,
  );
});

test("anyOf and oneOf propagate warnings and reject ambiguous matches", () => {
  const anyMatch = validate({
    type: "object",
    properties: {
      value: { anyOf: [null, { type: "string", pattern: "^(a+)+$" }, { type: "number" }] },
    },
  }, { value: "aaaa!" });
  assert.equal(anyMatch.ok, true);
  assert.deepEqual(anyMatch.warnings.map((warning) => warning.code), ["pattern_nested_quantifier"]);

  assert.match(
    errorText(validate(
      { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      { value: false },
    )),
    /arguments\.value does not match any allowed schema/,
  );

  const oneMatch = validate({
    type: "object",
    properties: {
      value: { oneOf: [{ type: "string", pattern: "^(a+)+$" }, { type: "number" }] },
    },
  }, { value: "aaaa!" });
  assert.equal(oneMatch.ok, true);
  assert.deepEqual(oneMatch.warnings.map((warning) => warning.code), ["pattern_nested_quantifier"]);

  assert.match(
    errorText(validate(
      { type: "object", properties: { value: { oneOf: [{ type: "string" }, {}] } } },
      { value: "ambiguous" },
    )),
    /arguments\.value must match exactly one allowed schema/,
  );
  assert.match(
    errorText(validate(
      { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } } },
      { value: false },
    )),
    /arguments\.value must match exactly one allowed schema/,
  );
});

test("enum comparison is canonical for objects and reports rejected values", () => {
  const parameters = {
    type: "object",
    properties: {
      payload: { enum: [{ a: 1, b: { c: 2 } }, "allowed"] },
    },
  };
  assert.equal(validate(parameters, { payload: { b: { c: 2 }, a: 1 } }).ok, true);
  assert.match(errorText(validate(parameters, { payload: "rejected" })), /arguments\.payload must be one of/);
});

test("object schemas enforce required, additional, and property-count limits", () => {
  assert.match(
    errorText(validate(
      { type: "object", required: ["path", 123], properties: { path: { type: "string" }, 123: { type: "number" } } },
      {},
      1,
    )),
    /arguments\.path is required/,
  );

  assert.match(
    errorText(validate(
      { type: "object", properties: { known: { type: "string" } }, additionalProperties: false },
      { known: "ok", extra: true },
    )),
    /arguments\.extra is not allowed by schema/,
  );

  assert.equal(validate({ type: "object", properties: "invalid" }, { extra: true }).ok, true);
  assert.match(errorText(validate({ type: "object", minProperties: 1 }, {})), /at least 1 property/);
  assert.match(errorText(validate({ type: "object", minProperties: 2 }, { one: 1 })), /at least 2 properties/);
  assert.match(errorText(validate({ type: "object", maxProperties: 1 }, { one: 1, two: 2 })), /at most 1 property/);
  assert.match(errorText(validate({ type: "object", maxProperties: 2 }, { one: 1, two: 2, three: 3 })), /at most 2 properties/);

  assert.match(
    errorText(validate({
      type: "object",
      properties: {
        nested: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
    }, { nested: {} })),
    /arguments\.nested\.value is required/,
  );
});

test("error collection stops at the configured deterministic boundary", () => {
  const result = validate({
    type: "object",
    required: ["one", "two", "three"],
    properties: {},
  }, {}, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["arguments.one is required", "arguments.two is required"]);

  for (const invalidLimit of [0, -1, Number.NaN]) {
    const bounded = validate({ type: "object", required: ["one"] }, {}, invalidLimit);
    assert.equal(bounded.ok, false);
    assert.deepEqual(bounded.errors, ["arguments.one is required"]);
  }
});
