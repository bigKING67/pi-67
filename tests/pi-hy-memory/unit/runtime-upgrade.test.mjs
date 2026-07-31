import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryUpgradeExecutor } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

const prior = runtime("prior");
const candidate = runtime("candidate");

test("runtime upgrade stages before locking and preserves a running service on success", async () => {
  const fixture = upgradeFixture();
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.success, true);
  assert.equal(result.phase, "COMPLETED");
  assert.equal(result.restarted, true);
  assert.deepEqual(fixture.events, [
    "stage", "lock", "snapshot", "inspect", "stop", "activate:candidate", "start:candidate", "release",
  ]);
});

test("runtime upgrade preserves a stopped service state", async () => {
  const fixture = upgradeFixture({ inspectServiceState: async () => ({ running: false }) });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.success, true);
  assert.equal(result.serviceBefore, "stopped");
  assert.equal(result.restarted, false);
  assert.deepEqual(fixture.events, ["stage", "lock", "snapshot", "inspect", "activate:candidate", "release"]);
});

test("stage failure never locks, stops, or activates", async () => {
  const fixture = upgradeFixture({ stageRuntime: async () => { throw new Error("stage failed"); } });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.success, false);
  assert.equal(result.phase, "STAGE");
  assert.match(result.error, /stage failed/);
  assert.deepEqual(fixture.events, ["stage"]);
});

test("lock contention leaves the prior service and selection untouched", async () => {
  const fixture = upgradeFixture({ acquireLock: () => ({ acquired: false, token: "" }) });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.success, false);
  assert.equal(result.phase, "LOCK");
  assert.deepEqual(fixture.events, ["stage", "lock"]);
});

test("stop failure does not activate and always releases the lock", async () => {
  const fixture = upgradeFixture({ stopService: async () => { throw new Error("stop failed"); } });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.phase, "STOP");
  assert.equal(result.rollback.attempted, false);
  assert.deepEqual(fixture.events, ["stage", "lock", "snapshot", "inspect", "stop", "release"]);
});

test("activation failure restores the exact prior selection and running service", async () => {
  const fixture = upgradeFixture({ activateRuntime: async () => { throw new Error("activate failed"); } });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.phase, "ACTIVATE");
  assert.equal(result.rollback.selectionRestored, true);
  assert.equal(result.rollback.serviceRestored, true);
  assert.deepEqual(fixture.events, [
    "stage", "lock", "snapshot", "inspect", "stop", "activate:candidate", "restore:prior", "start:prior", "release",
  ]);
});

test("target readiness failure rolls back without executing the candidate twice", async () => {
  let targetStarts = 0;
  const fixture = upgradeFixture({
    startSelectedRuntime: async (_ctx, input) => {
      if (input.runtime.serviceScript.includes("candidate")) {
        targetStarts += 1;
        const error = new Error("target readiness failed");
        error.serviceQuiesced = true;
        throw error;
      }
      return { running: true };
    },
  });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.phase, "TARGET_READINESS");
  assert.equal(targetStarts, 1);
  assert.equal(result.rollback.selectionRestored, true);
  assert.equal(result.rollback.serviceRestored, true);
  assert.deepEqual(fixture.events, [
    "stage", "lock", "snapshot", "inspect", "stop", "activate:candidate", "start:candidate", "restore:prior",
    "start:prior", "release",
  ]);
});

test("an unquiesced target blocks pointer rollback and prior restart", async () => {
  const fixture = upgradeFixture({
    startSelectedRuntime: async () => {
      const error = new Error("target still alive");
      error.serviceQuiesced = false;
      throw error;
    },
  });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.phase, "TARGET_READINESS");
  assert.equal(result.rollback.selectionRestored, false);
  assert.equal(result.rollback.serviceRestoreAttempted, false);
  assert.equal(result.rollback.failures[0].phase, "ROLLBACK_QUIESCE");
  assert.deepEqual(fixture.events, [
    "stage", "lock", "snapshot", "inspect", "stop", "activate:candidate", "start:candidate", "release",
  ]);
});

test("selection rollback failure does not start the prior service", async () => {
  const fixture = upgradeFixture({
    activateRuntime: async () => { throw new Error("activate failed"); },
    restoreSelection: async () => { throw new Error("restore failed"); },
  });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.rollback.selectionRestored, false);
  assert.equal(result.rollback.serviceRestoreAttempted, false);
  assert.equal(result.rollback.failures[0].phase, "ROLLBACK_SELECTION");
  assert.deepEqual(fixture.events, [
    "stage", "lock", "snapshot", "inspect", "stop", "activate:candidate", "restore:prior", "release",
  ]);
});

test("prior restart failure remains observable after selection rollback", async () => {
  const fixture = upgradeFixture({
    activateRuntime: async () => { throw new Error("activate failed"); },
    startSelectedRuntime: async () => { throw new Error("prior restart failed"); },
  });
  const result = await fixture.execute({}, fixture.options);

  assert.equal(result.rollback.selectionRestored, true);
  assert.equal(result.rollback.serviceRestoreAttempted, true);
  assert.equal(result.rollback.serviceRestored, false);
  assert.equal(result.rollback.failures[0].phase, "ROLLBACK_RESTART");
});

function upgradeFixture(overrides = {}) {
  const events = [];
  const ports = {
    stageRuntime: async () => {
      events.push("stage");
      return { runtime: candidate, root: "/runtime/candidate", created: true, reused: false };
    },
    acquireLock: () => {
      events.push("lock");
      return { acquired: true, token: "fixture-lock" };
    },
    releaseLock: () => { events.push("release"); },
    captureSelection: () => {
      events.push("snapshot");
      return { exists: true, bytes: Buffer.from("prior"), sha256: "0".repeat(64), runtime: prior };
    },
    inspectServiceState: async () => {
      events.push("inspect");
      return { running: true };
    },
    stopService: async () => { events.push("stop"); },
    activateRuntime: async (_paths, value) => {
      events.push(`activate:${runtimeName(value)}`);
      return value;
    },
    restoreSelection: async (_paths, snapshot) => {
      events.push("restore:prior");
      return snapshot.runtime;
    },
    startSelectedRuntime: async (_ctx, input) => {
      events.push(`start:${runtimeName(input.runtime)}`);
      return { running: true };
    },
  };
  for (const [name, implementation] of Object.entries(overrides)) {
    const original = ports[name];
    ports[name] = async (...args) => {
      if (name === "stageRuntime") events.push("stage");
      else if (name === "acquireLock") events.push("lock");
      else if (name === "inspectServiceState") events.push("inspect");
      else if (name === "stopService") events.push("stop");
      else if (name === "activateRuntime") events.push(`activate:${runtimeName(args[1])}`);
      else if (name === "restoreSelection") events.push("restore:prior");
      else if (name === "startSelectedRuntime") events.push(`start:${runtimeName(args[1].runtime)}`);
      return await implementation(...args, original);
    };
  }
  return {
    events,
    execute: createMemoryUpgradeExecutor(ports),
    options: { paths: { root: "/fixture" }, force: false, timeoutMs: 100 },
  };
}

function runtime(name) {
  return {
    schema: "pi67-hy-memory-runtime/v1",
    sdkVersion: "1.2.20",
    python: `/runtime/${name}/venv/bin/python`,
    serviceScript: `/runtime/${name}/service.py`,
    wrapperSha256: name === "prior" ? "1".repeat(64) : "2".repeat(64),
    wheelSha256: "3".repeat(64),
    installedAt: "2026-07-31T00:00:00.000Z",
  };
}

function runtimeName(value) {
  return value.serviceScript.includes("prior") ? "prior" : "candidate";
}
