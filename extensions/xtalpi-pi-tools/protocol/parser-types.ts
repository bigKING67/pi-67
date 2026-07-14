import type { PiToolCallEnvelope } from "../protocol.ts";

export type ToolCallParseResult =
  | {
      kind: "none";
      text: string;
    }
  | {
      kind: "tool_call";
      call: PiToolCallEnvelope;
      before: string;
      after: string;
      rawJson: string;
      warnings: string[];
    }
  | {
      kind: "error";
      code:
        | "function_style_tool_call"
        | "selected_tool_direct_kind"
        | "multiple_tool_calls"
        | "invalid_json"
        | "invalid_envelope"
        | "invalid_name"
        | "invalid_arguments"
        | "raw_protocol_markup"
        | "unknown_top_level_field";
      message: string;
      raw: string;
      text: string;
    };
