import assert from "node:assert/strict";
import test from "node:test";

import * as legacyRuntimeEnv from "../../../extensions/xtalpi-pi-tools/config/legacy-runtime-env.ts";
import {
  DEFAULT_MAX_EMPTY_RETRIES,
  DEFAULT_MAX_REPAIR_RETRIES,
  DEFAULT_MAX_TOTAL_RECOVERIES,
} from "../../../extensions/xtalpi-pi-tools/protocol.ts";
import * as retryFacade from "../../../extensions/xtalpi-pi-tools/retry.ts";
import * as recoveryPrompts from "../../../extensions/xtalpi-pi-tools/turn/recovery-prompts.ts";
import { withRuntimeEnv } from "../test-support.mjs";

test("retry facade re-exports canonical implementations without wrappers", () => {
  const canonical = { ...legacyRuntimeEnv, ...recoveryPrompts };
  assert.deepEqual(Object.keys(retryFacade).sort(), Object.keys(canonical).sort());
  for (const [name, implementation] of Object.entries(canonical)) {
    assert.strictEqual(retryFacade[name], implementation, name);
  }
});

test("legacy envInt accepts only complete safe decimal integers", async () => {
  const name = "XTALPI_PI_TOOLS_TEST_INTEGER";
  await withRuntimeEnv({ [name]: undefined }, () => {
    assert.equal(legacyRuntimeEnv.envInt(name, 9), 9);

    const accepted = [
      ["42", 0, 42],
      [" +7 ", 0, 7],
      ["-2", -5, -2],
      ["0008", 0, 8],
    ];
    for (const [raw, min, expected] of accepted) {
      process.env[name] = raw;
      assert.equal(legacyRuntimeEnv.envInt(name, 9, min), expected, raw);
    }

    for (const raw of ["-1", "1.5", "1e3", "1000ms", "Infinity", "9007199254740992", "   "]) {
      process.env[name] = raw;
      assert.equal(legacyRuntimeEnv.envInt(name, 9), 9, raw);
    }
  });
});

test("legacy recovery getters preserve defaults and honor strict env values", async () => {
  await withRuntimeEnv({}, () => {
    assert.equal(legacyRuntimeEnv.maxEmptyRetries(), DEFAULT_MAX_EMPTY_RETRIES);
    assert.equal(legacyRuntimeEnv.maxRepairRetries(), DEFAULT_MAX_REPAIR_RETRIES);
    assert.equal(legacyRuntimeEnv.maxTotalRecoveries(), DEFAULT_MAX_TOTAL_RECOVERIES);
  });

  await withRuntimeEnv({
    XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES: "0",
    XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: "3",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "8",
  }, () => {
    assert.equal(retryFacade.maxEmptyRetries(), 0);
    assert.equal(retryFacade.maxRepairRetries(), 3);
    assert.equal(retryFacade.maxTotalRecoveries(), 8);
  });

  await withRuntimeEnv({
    XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES: "2 retries",
    XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES: "1.5",
    XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES: "9007199254740992",
  }, () => {
    assert.equal(retryFacade.maxEmptyRetries(), DEFAULT_MAX_EMPTY_RETRIES);
    assert.equal(retryFacade.maxRepairRetries(), DEFAULT_MAX_REPAIR_RETRIES);
    assert.equal(retryFacade.maxTotalRecoveries(), DEFAULT_MAX_TOTAL_RECOVERIES);
  });
});
