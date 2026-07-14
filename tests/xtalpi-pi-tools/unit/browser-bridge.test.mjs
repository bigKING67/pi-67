import assert from "node:assert/strict";
import test from "node:test";

import {
  detectBrowserMcpTaskText,
} from "../../../extensions/xtalpi-pi-tools/browser-bridge.ts";

test("browser detection rejects generic actions outside a browser surface", () => {
  for (const prompt of [
    "上传文件到知识库",
    "下载飞书文档附件",
    "点击运行测试按钮",
    "Use MCP to inspect the database schema",
    "Use MCP to inspect the active queue",
    "查看网站项目的配置文件",
    "检查页面组件代码",
    "下载页面源码",
    "上传网页静态资源",
    "Inspect browser compatibility code",
  ]) {
    assert.equal(detectBrowserMcpTaskText(prompt).isBrowserMcpTask, false, prompt);
  }
});

test("browser detection keeps explicit browser and URL screenshot tasks", () => {
  for (const prompt of [
    "使用 browser67 打开 https://example.invalid 并截图",
    "用 Chrome 打开蝉妈妈首页",
    "上传文件到网页表单",
    "Take a screenshot of https://example.invalid",
    "请对 https://example.invalid 截图",
    "Take a screenshot of the current page",
  ]) {
    assert.equal(detectBrowserMcpTaskText(prompt).isBrowserMcpTask, true, prompt);
  }
});

test("explicit browser rejection wins unless only the default browser is forbidden", () => {
  const forbidden = detectBrowserMcpTaskText("Do not use browser67; inspect the local fixture instead.");
  assert.deepEqual(forbidden, {
    isBrowserMcpTask: false,
    reasonCodes: ["prompt_browser_forbidden"],
  });

  const managedBrowser = detectBrowserMcpTaskText(
    "不要用默认浏览器，请使用 browser67 打开 https://example.invalid。",
  );
  assert.equal(managedBrowser.isBrowserMcpTask, true);
  assert.ok(managedBrowser.reasonCodes.includes("prompt_browser_tool_name"));

  const directBrowser = detectBrowserMcpTaskText(
    "Do not use MCP; use browser67 to inspect the current tab.",
  );
  assert.equal(directBrowser.isBrowserMcpTask, true);
  assert.ok(directBrowser.reasonCodes.includes("prompt_browser_tool_name"));
});
