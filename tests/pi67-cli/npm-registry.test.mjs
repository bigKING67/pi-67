import assert from "node:assert/strict";
import test from "node:test";
import {
  npmExactVersionStatus,
  npmLatestVersion,
  npmRegistryPackageUrl,
  npmRegistryVersionUrl,
} from "../../packages/pi67-cli/src/lib/npm-registry.mjs";

test("registry URLs encode scoped packages and exact versions", () => {
  assert.equal(
    npmRegistryPackageUrl("@bigking67/pi-67"),
    "https://registry.npmjs.org/@bigking67%2Fpi-67/latest",
  );
  assert.equal(
    npmRegistryVersionUrl("@bigking67/pi-67", "0.15.7-beta.1"),
    "https://registry.npmjs.org/@bigking67%2Fpi-67/0.15.7-beta.1",
  );
});

test("exact-version lookup distinguishes available and already-published versions", async () => {
  const available = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => jsonResponse(404, { error: "not found" }),
  });
  assert.equal(available.ok, true);
  assert.equal(available.exists, false);

  const published = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => jsonResponse(200, { version: "1.2.3" }),
  });
  assert.equal(published.ok, true);
  assert.equal(published.exists, true);
  assert.equal(published.publishedVersion, "1.2.3");
});

test("exact-version lookup fails closed on mismatched or malformed registry payloads", async () => {
  const mismatched = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => jsonResponse(200, { version: "1.2.2" }),
  });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.message, /exact-version mismatch/);

  const malformed = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => jsonResponse(200, { name: "@example/pkg" }),
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /returned no version/);
});

test("exact-version lookup fails closed on registry and transport errors", async () => {
  const unavailable = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => jsonResponse(503, { error: "unavailable" }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.exists, false);
  assert.match(unavailable.message, /HTTP 503/);

  const invalidJson = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        throw new SyntaxError("invalid JSON");
      },
    }),
  });
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.message, /invalid JSON/);

  const timeout = await npmExactVersionStatus("@example/pkg", "1.2.3", {
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /timed out/);
});

test("latest lookup remains independent from exact-version publication state", async () => {
  const latest = await npmLatestVersion("@example/pkg", {
    currentVersion: "1.2.2",
    fetchImpl: async () => jsonResponse(200, { version: "1.2.3" }),
  });
  assert.equal(latest.ok, true);
  assert.equal(latest.latestVersion, "1.2.3");
  assert.equal(latest.outdated, true);

  const skipped = await npmExactVersionStatus("@example/pkg", "1.2.3", { noRemote: true });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.exists, false);
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    async json() {
      return payload;
    },
  };
}
