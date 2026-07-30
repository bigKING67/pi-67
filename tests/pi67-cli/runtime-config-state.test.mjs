import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_CONFIG_TEMPLATES,
  migrateSettingsRuntimeState,
} from "../../packages/pi67-cli/src/lib/settings-runtime-state.mjs";

test("runtime state seeds missing local configs and preserves existing user files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-runtime-config-"));
  const repoRoot = path.join(root, "release");
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(root, "state");
  try {
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "settings.example.json"), '{"theme":"dark"}\n');
    for (const [templateName, targetName] of LOCAL_CONFIG_TEMPLATES) {
      fs.writeFileSync(path.join(repoRoot, templateName), `${JSON.stringify({ targetName })}\n`);
    }
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "models.json"), '{"userOwned":true}\n');

    const result = migrateSettingsRuntimeState({ repoRoot, agentDir, stateDir });

    assert.equal(result.settingsCreatedFromTemplate, true);
    assert.deepEqual(result.localConfigFiles.preserved, ["models.json"]);
    assert.deepEqual(result.localConfigFiles.createdFromTemplate, [
      "mcp.json",
      "auth.json",
      "image-gen.json",
    ]);
    assert.deepEqual(result.localConfigFiles.missingTemplates, []);
    assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), '{"userOwned":true}\n');
    assert.equal(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8"), '{"targetName":"mcp.json"}\n');

    const repeated = migrateSettingsRuntimeState({ repoRoot, agentDir, stateDir });
    assert.deepEqual(repeated.localConfigFiles.createdFromTemplate, []);
    assert.deepEqual(repeated.localConfigFiles.preserved, LOCAL_CONFIG_TEMPLATES.map(([, target]) => target));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime config dry-run reports creations without writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi67-runtime-config-dry-"));
  const repoRoot = path.join(root, "release");
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(root, "state");
  try {
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "settings.example.json"), "{}\n");
    for (const [templateName] of LOCAL_CONFIG_TEMPLATES) {
      fs.writeFileSync(path.join(repoRoot, templateName), "{}\n");
    }

    const result = migrateSettingsRuntimeState({ repoRoot, agentDir, stateDir }, { dryRun: true });

    assert.equal(result.settingsCreatedFromTemplate, true);
    assert.deepEqual(
      result.localConfigFiles.createdFromTemplate,
      LOCAL_CONFIG_TEMPLATES.map(([, target]) => target),
    );
    assert.equal(fs.existsSync(agentDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
