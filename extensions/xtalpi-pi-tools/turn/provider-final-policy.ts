import type {
  FinalGuardResult,
} from "../final-guard.ts";
import {
  buildPlanModeFallbackPlan,
  buildPrematureFinalRepairPrompt,
} from "./recovery-prompts.ts";
import { safeBlockText } from "../text-safety.ts";
import {
  buildVisionBridgeToolCallRepairPrompt,
  isVisionInabilityFinal,
  type VisionTaskDetection,
} from "../vision-bridge.ts";
import type { ToolExecutionLedger } from "./tool-execution-ledger.ts";

type FinalGuardViolation = Extract<FinalGuardResult, { ok: false }>;

export type FinalGuardPolicyDecision =
  | { kind: "accept" }
  | { kind: "recover"; prompt: string; violation: FinalGuardViolation }
  | { kind: "fallback"; text: string; violation: FinalGuardViolation }
  | { kind: "reject"; text: string; violation: FinalGuardViolation };

export type VisionInabilityDecision =
  | { kind: "none" }
  | { kind: "recover"; prompt: string; toolName: string }
  | { kind: "final"; text: string };

export function canAcceptImmediatePostToolPlainFinal(input: {
  parseErrorCode: string;
  raw: string;
  finalPolicy: FinalGuardPolicyDecision;
  toolLedger: Pick<ToolExecutionLedger, "latestObservation" | "pendingCallCount">;
  contextMessageCount: number;
  totalRecoveries: number;
}): boolean {
  const latestObservation = input.toolLedger.latestObservation;
  return input.parseErrorCode === "invalid_json" &&
    !input.raw.trimStart().startsWith("{") &&
    input.finalPolicy.kind === "accept" &&
    latestObservation?.status === "success" &&
    latestObservation.resultMessageIndex === input.contextMessageCount - 1 &&
    input.toolLedger.pendingCallCount === 0 &&
    input.totalRecoveries === 0;
}

export function finalGuardRequiresPlanBlock(input: { code: string; reason: string }): boolean {
  return input.code === "plan_mode_contract_missing" ||
    /(?:Plan mode|<proposed_plan>)/i.test(input.reason);
}

export function decideFinalGuardPolicy(input: {
  guard: FinalGuardResult;
  raw: string;
  selectedToolNames: readonly string[];
  canRecover: boolean;
}): FinalGuardPolicyDecision {
  if (input.guard.ok) return { kind: "accept" };

  if (input.canRecover) {
    return {
      kind: "recover",
      prompt: buildPrematureFinalRepairPrompt({
        code: input.guard.code,
        reason: input.guard.reason,
        raw: input.raw,
        latestUserText: input.guard.latestUserText,
        availableNames: [...input.selectedToolNames],
        forcePlanBlock: finalGuardRequiresPlanBlock(input.guard),
      }),
      violation: input.guard,
    };
  }

  if (finalGuardRequiresPlanBlock(input.guard)) {
    return {
      kind: "fallback",
      text: buildPlanModeFallbackPlan({
        code: input.guard.code,
        reason: input.guard.reason,
        latestUserText: input.guard.latestUserText,
      }),
      violation: input.guard,
    };
  }

  return {
    kind: "reject",
    text:
      `xtalpi-pi-tools 检测到模型返回疑似未完成的最终回答，已停止自动修复。\n\n` +
      `原因：${input.guard.reason}\n\n模型原始输出摘录：\n${safeBlockText(input.raw, 2000)}`,
    violation: input.guard,
  };
}

export function decideVisionInability(input: {
  detection: VisionTaskDetection;
  selectedVisionTool?: string;
  text: string;
  latestUserText: string;
  canRecover: boolean;
}): VisionInabilityDecision {
  if (
    !input.detection.isVisionTask ||
    !input.selectedVisionTool ||
    !isVisionInabilityFinal(input.text)
  ) {
    return { kind: "none" };
  }

  if (input.canRecover) {
    return {
      kind: "recover",
      toolName: input.selectedVisionTool,
      prompt: buildVisionBridgeToolCallRepairPrompt({
        toolName: input.selectedVisionTool,
        detection: input.detection,
        latestUserText: input.latestUserText,
      }),
    };
  }

  return {
    kind: "final",
    text: "xtalpi-pi-tools 检测到图片/截图任务，但模型没有调用本地 vision bridge，且自动修复预算已用尽。请重试上一句，或运行 pi-67 doctor 检查 vision_read/image_review 是否 ready。",
  };
}
