import assert from "node:assert/strict";
import test from "node:test";

import { validateShellCommandRequest } from "../../../extensions/xtalpi-pi-tools/shell-command-guard.ts";

function bash(command) {
  return { name: "bash", arguments: { command } };
}

test("non-bash calls and missing command arguments pass through", () => {
  assert.deepEqual(validateShellCommandRequest({ name: "read", arguments: { path: "package.json" } }), { ok: true });
  assert.deepEqual(validateShellCommandRequest({ name: "bash", arguments: {} }), { ok: true });
  assert.deepEqual(validateShellCommandRequest({ name: "bash", arguments: { command: 42 } }), { ok: true });
});

test("raw PowerShell syntax is rejected before it reaches bash", () => {
  for (const command of [
    'Get-ChildItem -Recurse -Filter "pi67" -ErrorAction SilentlyContinue',
    "printf test | Select-Object -First 1",
    "echo $env:HOME",
    "Write-Output `n",
  ]) {
    const result = validateShellCommandRequest(bash(command));
    assert.equal(result.ok, false, command);
    assert.equal(result.code, "powershell_syntax_in_bash", command);
    assert.equal(result.command, command);
    assert.ok(result.errors.length >= 2);
  }
});

test("explicit PowerShell invocations require bash-safe script paths", () => {
  for (const command of [
    String.raw`powershell -ExecutionPolicy Bypass -File .\scripts\pi67-smoke.ps1 -Ci`,
    String.raw`pwsh.exe -File C:\scripts\pi67-smoke.ps1`,
  ]) {
    const result = validateShellCommandRequest(bash(command));
    assert.equal(result.ok, false, command);
    assert.equal(result.code, "windows_path_escaping_in_bash", command);
  }

  for (const command of [
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/pi67-smoke.ps1 -Ci",
    String.raw`pwsh-preview -File '.\scripts\pi67-smoke.ps1'`,
    'powershell -Command "Get-ChildItem | Select-Object -First 1"',
  ]) {
    assert.deepEqual(validateShellCommandRequest(bash(command)), { ok: true }, command);
  }
});

test("browser67 tasks reject system-browser launches and CLI probes", () => {
  const prompt = "Use browser67 to open https://example.invalid and inspect the current tab.";
  for (const command of [
    "open https://example.invalid",
    "xdg-open https://example.invalid",
    "cmd.exe /c start https://example.invalid",
    "python3 -m webbrowser https://example.invalid",
    'osascript -e \'open location "https://example.invalid"\'',
    'open -a "Google Chrome"',
    "which browser67",
    "npm ls -g browser67",
    "ls -la ~/.browser67/",
  ]) {
    const result = validateShellCommandRequest({
      requestedCall: bash(command),
      toolSelectionPromptText: prompt,
      selectedToolNames: new Set(["bash", "mcp"]),
    });
    assert.equal(result.ok, false, command);
    assert.equal(result.code, "browser_task_shell_open_misroute", command);
    assert.match(result.reason, /selected mcp gateway/);
  }
});

test("browser misroute diagnostics distinguish a missing MCP selection", () => {
  const result = validateShellCommandRequest({
    requestedCall: bash('open -a "Google Chrome" "https://example.invalid"'),
    toolSelectionPromptText: "用 browser67 打开网页并截图",
    selectedToolNames: ["bash"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "browser_task_shell_open_misroute");
  assert.match(result.reason, /no browser MCP tool was selected/);
});

test("ordinary URL tasks do not trigger the browser67-specific shell guard", () => {
  assert.deepEqual(
    validateShellCommandRequest({
      requestedCall: bash("open https://example.invalid"),
      toolSelectionPromptText: "Summarize the text at https://example.invalid without using a browser.",
      selectedToolNames: ["bash"],
    }),
    { ok: true },
  );
});
