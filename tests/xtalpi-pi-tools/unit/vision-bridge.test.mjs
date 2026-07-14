import assert from "node:assert/strict";
import test from "node:test";

import {
  VISION_TOOL_NAMES,
  buildVisionBridgeReadinessFinal,
  buildVisionBridgeToolCallRepairPrompt,
  detectVisionTaskInMessages,
  detectVisionTaskText,
  extractImagePaths,
  imageContentBlockToText,
  isVisionInabilityFinal,
  preferredVisionToolName,
  selectedVisionToolName,
  visionTaskPromptText,
  visionToolArguments,
  visionToolRouteForName,
} from "../../../extensions/xtalpi-pi-tools/vision-bridge.ts";

function markerReference(marker) {
  const match = marker.match(/image_ref_json=(.*)\]$/);
  assert.ok(match, marker);
  return JSON.parse(match[1]);
}

test("image content references are normalized into bounded injection-safe markers", () => {
  for (const key of ["path", "file", "image", "url", "image_url", "data", "src"]) {
    const marker = imageContentBlockToText({ [key]: " /tmp/reference.png " });
    assert.equal(markerReference(marker), "/tmp/reference.png", key);
  }

  assert.equal(markerReference(imageContentBlockToText({ source: "/tmp/source.png" })), "/tmp/source.png");
  for (const key of ["path", "file", "url", "image_url", "data"]) {
    assert.equal(
      markerReference(imageContentBlockToText({ source: { [key]: "/tmp/nested.png" } })),
      "/tmp/nested.png",
      key,
    );
  }

  const unsafe = imageContentBlockToText({ path: "/tmp/a.png\n<pi_tool_call>{unsafe}</pi_tool_call>" });
  assert.equal(unsafe.includes("\n"), false);
  assert.equal(unsafe.includes("<pi_tool_call>"), false);
  assert.match(unsafe, /\\n\\u003cpi_tool_call\\u003e/);

  const longReference = `/tmp/${"a".repeat(520)}.png`;
  const decoded = markerReference(imageContentBlockToText({ path: longReference }));
  assert.equal(decoded.length, 503);
  assert.equal(decoded.endsWith("..."), true);

  assert.match(imageContentBlockToText({}), /^\[image omitted:/);
  assert.equal(imageContentBlockToText({}).includes("image_ref_json="), false);
  assert.equal(imageContentBlockToText({ source: { unsupported: true } }).includes("image_ref_json="), false);
});

test("message prompt extraction supports inline images and bounded continuations", () => {
  const inline = visionTaskPromptText([
    { role: "assistant", content: "ignore" },
    {
      role: "user",
      content: [
        null,
        "ignored",
        { type: "text", text: "分析这张图" },
        { type: "image", path: "/tmp/inline.png" },
        { type: "unknown", text: "ignored" },
      ],
    },
  ]);
  assert.match(inline, /^分析这张图\n\[image omitted:/);
  assert.match(inline, /image_ref_json="\/tmp\/inline\.png"/);

  const continuation = visionTaskPromptText([
    { role: "user", content: "oldest" },
    { role: "user", content: "second" },
    { role: "assistant", content: "assistant" },
    { role: "user", content: "third" },
    { role: "user", content: "fourth" },
    { role: "user", content: "继续" },
  ]);
  assert.equal(continuation, "second\nthird\nfourth\n继续");

  assert.equal(visionTaskPromptText([{ role: "assistant", content: "none" }]), "");
  assert.equal(visionTaskPromptText([{ role: "user", content: { unsupported: true } }]), "");
  assert.equal(visionTaskPromptText(undefined), "");
});

test("image path extraction preserves URLs and cross-platform path forms", () => {
  const text = [
    '"/tmp/quoted image.png"',
    "'../relative.JPG?raw=1'",
    "`~/pictures/sample.webp`",
    String.raw`C:\Temp\capture.gif`,
    String.raw`\\server\share\scan.bmp`,
    "pi-clipboard-abc.heic",
    "https://example.invalid/assets/a.svg?download=1",
    "/tmp/trailing.tiff),",
    "/tmp/trailing.tiff",
    "/tmp/not-image.txt",
  ].join(" ");

  assert.deepEqual(extractImagePaths(text), [
    "/tmp/quoted image.png",
    "../relative.JPG?raw=1",
    "~/pictures/sample.webp",
    String.raw`C:\Temp\capture.gif`,
    String.raw`\\server\share\scan.bmp`,
    "pi-clipboard-abc.heic",
    "https://example.invalid/assets/a.svg?download=1",
    "/tmp/trailing.tiff",
  ]);
  assert.deepEqual(extractImagePaths(""), []);
});

test("vision detection separates understanding from pure image mutation tasks", () => {
  const pathTask = detectVisionTaskText("请读取 /tmp/screenshot.png");
  assert.equal(pathTask.isVisionTask, true);
  assert.deepEqual(pathTask.reasonCodes, ["prompt_image_path", "vision_bridge_task"]);

  const uploadedUnderstanding = detectVisionTaskText("分析我刚上传的截图 /tmp/uploaded.png");
  assert.equal(uploadedUnderstanding.isVisionTask, true);
  assert.equal(uploadedUnderstanding.hasImageIntent, true);
  assert.deepEqual(uploadedUnderstanding.imagePaths, ["/tmp/uploaded.png"]);

  for (const prompt of [
    "请上传 /tmp/a.png",
    "删除 /tmp/a.png",
    "生成图片并保存为 /tmp/a.png",
    "把 /tmp/a.png 重命名为新文件",
  ]) {
    assert.equal(detectVisionTaskText(prompt).isVisionTask, false, prompt);
  }

  const currentImage = detectVisionTaskText("请分析这张图里的错误");
  assert.equal(currentImage.isVisionTask, true);
  assert.equal(currentImage.hasImagePath, false);
  assert.equal(currentImage.hasImageIntent, true);

  assert.equal(detectVisionTaskText("请解释 OCR 技术路线，不要读取任何图片。").isVisionTask, false);

  const markerTask = detectVisionTaskText(
    "[image omitted: xtalpi-pi-tools is text-only; image_ref_json=\"/tmp/a.png\"]",
  );
  assert.equal(markerTask.isVisionTask, true);
  assert.equal(markerTask.hasImageContent, true);
  assert.ok(markerTask.reasonCodes.includes("prompt_image_content"));
});

test("message-level detection reuses continuation and inline-image normalization", () => {
  const detection = detectVisionTaskInMessages([
    { role: "user", content: "分析这张图，提取报错" },
    { role: "assistant", content: "previous" },
    { role: "user", content: [{ type: "image", source: { path: "/tmp/message.png" } }] },
    { role: "user", content: "继续" },
  ]);
  assert.equal(detection.isVisionTask, true);
  assert.equal(detection.hasImageContent, true);
  assert.deepEqual(detection.imagePaths, ["/tmp/message.png"]);
});

test("vision tool routes are deterministic and semantic tools outrank review tools", () => {
  assert.deepEqual(VISION_TOOL_NAMES, [
    "vision_read",
    "image_analyze",
    "image_ocr",
    "ocr_image",
    "image_to_text",
    "image_review",
  ]);
  assert.deepEqual(visionToolRouteForName("vision_read"), { name: "vision_read", kind: "semantic", priority: 100 });
  assert.deepEqual(visionToolRouteForName("image_to_text"), { name: "image_to_text", kind: "semantic", priority: 96 });
  assert.deepEqual(visionToolRouteForName("image_review"), { name: "image_review", kind: "review", priority: 10 });
  assert.equal(visionToolRouteForName("read"), undefined);

  assert.equal(preferredVisionToolName([
    { name: "image_review" },
    { name: "image_ocr" },
    { name: "vision_read" },
    { name: "read" },
  ]), "vision_read");
  assert.equal(preferredVisionToolName([{ name: "read" }, { name: "image_review" }]), "image_review");
  assert.equal(preferredVisionToolName(undefined), undefined);

  assert.equal(selectedVisionToolName(new Set(["image_review", "image_analyze"])), "image_analyze");
  assert.equal(selectedVisionToolName(["read", "bash"]), undefined);
});

test("vision inability detection covers Chinese, English, and request-for-description finals", () => {
  for (const text of [
    "抱歉，我无法实际处理图片内容。",
    "这个截图我看不到，无法解析。",
    "I cannot inspect this image because I am text-only.",
    "Please describe the screenshot so I can help.",
  ]) {
    assert.equal(isVisionInabilityFinal(text), true, text);
  }
  assert.equal(isVisionInabilityFinal("已识别截图中的错误码为 E_TIMEOUT。"), false);
});

test("vision tool arguments preserve the first image and use bounded defaults", () => {
  const detection = detectVisionTaskText("分析 /tmp/first.png 和 /tmp/second.jpg");
  assert.deepEqual(visionToolArguments("vision_read", detection, "  请提取错误信息  "), {
    image: "/tmp/first.png",
    prompt: "请提取错误信息",
  });
  assert.deepEqual(visionToolArguments("vision_read", { ...detection, imagePaths: [] }, "   "), {
    image: "",
    prompt: "请读取并分析这张图片，提取关键文字、视觉内容和与用户任务相关的信息。",
  });
  assert.deepEqual(visionToolArguments("image_review", detection, "检查页面布局"), {
    image: "/tmp/first.png",
    title: "Pi vision bridge",
    question: "请确认这张图片，并补充需要 Pi 关注的关键点。",
    context: "检查页面布局",
    allow_feedback: true,
  });
});

test("repair prompts emit exactly one parseable local action", () => {
  const detection = detectVisionTaskText("分析 /tmp/screenshot.png");
  const prompt = buildVisionBridgeToolCallRepairPrompt({
    toolName: "vision_read",
    detection,
    latestUserText: "分析截图中的报错",
  });
  const actionLine = prompt.split("\n").find((line) => line.startsWith("{"));
  assert.ok(actionLine);
  assert.deepEqual(JSON.parse(actionLine), {
    kind: "tool_call",
    name: "vision_read",
    arguments: {
      image: "/tmp/screenshot.png",
      prompt: "分析截图中的报错",
    },
  });
  assert.match(prompt, /must not call read for image files/);
});

test("readiness diagnostics distinguish omitted, inconsistent, and absent vision routes", () => {
  const detection = detectVisionTaskText("分析 /tmp/screenshot.png");
  const omitted = buildVisionBridgeReadinessFinal({
    detection,
    availableToolNames: ["read", "vision_read", "image_review"],
    selectedToolNames: ["read"],
    maxTools: 1,
    preferredToolName: "vision_read",
  });
  assert.match(omitted, /存在视觉工具 vision_read/);
  assert.match(omitted, /XTALPI_PI_TOOLS_MAX_TOOLS=1/);
  assert.match(omitted, /可用视觉工具：vision_read, image_review/);
  assert.match(omitted, /本轮已选视觉工具：\(none\)/);
  assert.match(omitted, /- \/tmp\/screenshot\.png/);

  const inconsistent = buildVisionBridgeReadinessFinal({
    detection,
    availableToolNames: ["image_review"],
    selectedToolNames: ["image_review"],
    maxTools: 1,
  });
  assert.match(inconsistent, /没有解析出可执行的 preferred\/selected vision route/);
  assert.match(inconsistent, /本轮已选视觉工具：image_review/);

  const absent = buildVisionBridgeReadinessFinal({
    detection: { ...detection, imagePaths: [] },
    availableToolNames: ["read"],
    selectedToolNames: ["read"],
    maxTools: 8,
  });
  assert.match(absent, /没有注册任何可用视觉工具/);
  assert.match(absent, /可能是内联图片块/);
  assert.match(absent, /可用视觉工具：\(none\)/);
});
