import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryServiceEnvironment as buildExtensionEnvironment } from "../../../extensions/pi-hy-memory/client.ts";
import { buildMemoryServiceEnvironment as buildCliEnvironment } from "../../../packages/pi67-cli/src/lib/memory-runtime.mjs";

test("extension and CLI services disable unsupported Hy-Memory persistence surfaces", () => {
  const extension = buildExtensionEnvironment({
    llmApiKey: "fixture-llm-key",
    embeddingApiKey: "fixture-embedding-key",
    bearerToken: "fixture-service-token",
    dataDir: "/fixture/extension-data",
  });
  const cli = buildCliEnvironment({
    llmKey: "fixture-llm-key",
    embeddingKey: "fixture-embedding-key",
    token: "fixture-service-token",
    dataDir: "/fixture/cli-data",
  });

  assert.equal(extension.MEMORY_PIPELINE_TRACE_ENABLED, "false");
  assert.equal(cli.MEMORY_PIPELINE_TRACE_ENABLED, "false");
  assert.equal(extension.MEMORY_TRACE_ENABLED, "false");
  assert.equal(cli.MEMORY_TRACE_ENABLED, "false");
  assert.equal(extension.MEMORY_CODING_ENABLED, "false");
  assert.equal(cli.MEMORY_CODING_ENABLED, "false");
  assert.equal(extension.MEMORY_HISTORY_ENABLE, "false");
  assert.equal(cli.MEMORY_HISTORY_ENABLE, "false");
  assert.equal(extension.MEMORY_MEMORY_OPERATIONS_ENABLED, "false");
  assert.equal(cli.MEMORY_MEMORY_OPERATIONS_ENABLED, "false");
  assert.equal(extension.MEMORY_DATA_DIR, "/fixture/extension-data");
  assert.equal(cli.MEMORY_DATA_DIR, "/fixture/cli-data");
});
