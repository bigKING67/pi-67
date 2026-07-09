import type { JsonObject } from "./protocol.ts";
import { detectBrowserMcpTaskText } from "./browser-bridge.ts";

export type ShellCommandGuardCode =
  | "powershell_syntax_in_bash"
  | "windows_path_escaping_in_bash"
  | "browser_task_shell_open_misroute";

export type ShellCommandGuardResult =
  | { ok: true }
  | {
      ok: false;
      code: ShellCommandGuardCode;
      reason: string;
      command: string;
      errors: string[];
    };

type ToolCallRequest = {
  name: string;
  arguments: JsonObject;
};

type ShellCommandGuardInput = ToolCallRequest | {
  requestedCall: ToolCallRequest;
  toolSelectionPromptText?: string;
  selectedToolNames?: Iterable<string>;
};

const POWERSHELL_INVOKER_PATTERN =
  /^\s*(?:(?:\S+[\\/])?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|pwsh-preview(?:\.exe)?))\b/i;

const RAW_POWERSHELL_CMDLET_START_PATTERN =
  /^\s*(?:Get|Set|New|Remove|Copy|Move|Rename|Test|Resolve|Select|Where|ForEach|Write|Start|Stop|Restart|Invoke|Import|Export|ConvertTo|ConvertFrom)-[A-Z][A-Za-z0-9-]*\b/;

const RAW_POWERSHELL_PIPE_CMDLET_PATTERN =
  /[|;&]\s*(?:Select|Where|ForEach|Sort|Group|Measure|Tee)-Object\b/i;

const RAW_POWERSHELL_ONLY_SYNTAX_PATTERN =
  /(?:\$env:|\$\{env:|`r\b|`n\b|\s-(?:ErrorAction|ExpandProperty)\b)/i;

const UNQUOTED_DOT_BACKSLASH_PATH_PATTERN = /(?:^|\s)(?:-File\s+)?\.\\[^\s'"]+/i;
const UNQUOTED_DRIVE_BACKSLASH_PATH_PATTERN = /(?:^|\s)[A-Za-z]:\\[^\s'"]+/;
const SHELL_OPEN_URL_PATTERN =
  /^\s*(?:(?:open|xdg-open)\s+|(?:cmd\.exe\s+\/c\s+)?start\s+|python(?:3)?\s+-m\s+webbrowser\s+|osascript\b[\s\S]*\bopen\s+location\b)[\s\S]*https?:\/\//i;
const SHELL_BROWSER_APP_OPEN_PATTERN =
  /^\s*(?:open\s+(?:-[^\s]+\s+)*(?:(?:"|')?(?:Google Chrome|Google Chrome Canary|Chromium|Microsoft Edge|Safari|Firefox)(?:"|')?|\/Applications\/(?:Google(?:\\ | )Chrome|Google(?:\\ | )Chrome(?:\\ | )Canary|Chromium|Microsoft(?:\\ | )Edge|Safari|Firefox)\.app)|osascript\b[\s\S]*\btell\s+application\s+(?:"|')?(?:Google Chrome|Google Chrome Canary|Chromium|Microsoft Edge|Safari|Firefox)(?:"|')?)/i;
const BROWSER67_CLI_PROBE_PATTERN =
  /(?:^|[;&|]\s*)(?:(?:which|command\s+-v)\s+browser67\b|npm\s+ls\s+-g\s+browser67\b|(?:ls|find)\s+(?:-[A-Za-z0-9]+\s+)*(?:"|')?(?:~|\$HOME)\/\.browser67\/?)/i;

function commandArgument(args: JsonObject): string | undefined {
  return typeof args.command === "string" ? args.command : undefined;
}

function startsWithPowerShellInvoker(command: string): boolean {
  return POWERSHELL_INVOKER_PATTERN.test(command);
}

function hasRawPowerShellSyntax(command: string): boolean {
  return RAW_POWERSHELL_CMDLET_START_PATTERN.test(command) ||
    RAW_POWERSHELL_PIPE_CMDLET_PATTERN.test(command) ||
    RAW_POWERSHELL_ONLY_SYNTAX_PATTERN.test(command);
}

function hasUnquotedWindowsBackslashPath(command: string): boolean {
  return UNQUOTED_DOT_BACKSLASH_PATH_PATTERN.test(command) ||
    UNQUOTED_DRIVE_BACKSLASH_PATH_PATTERN.test(command);
}

function normalizeInput(input: ShellCommandGuardInput): {
  requestedCall: ToolCallRequest;
  toolSelectionPromptText: string;
  selectedToolNames: string[];
} {
  if ("requestedCall" in input) {
    return {
      requestedCall: input.requestedCall,
      toolSelectionPromptText: String(input.toolSelectionPromptText ?? ""),
      selectedToolNames: [...(input.selectedToolNames ?? [])].map(String),
    };
  }

  return {
    requestedCall: input,
    toolSelectionPromptText: "",
    selectedToolNames: [],
  };
}

function isBrowserTaskShellMisroute(command: string, promptText: string): boolean {
  if (!detectBrowserMcpTaskText(promptText).isBrowserMcpTask) return false;
  return SHELL_OPEN_URL_PATTERN.test(command) ||
    SHELL_BROWSER_APP_OPEN_PATTERN.test(command) ||
    BROWSER67_CLI_PROBE_PATTERN.test(command);
}

export function validateShellCommandRequest(input: ShellCommandGuardInput): ShellCommandGuardResult {
  const {
    requestedCall,
    toolSelectionPromptText,
    selectedToolNames,
  } = normalizeInput(input);
  if (requestedCall.name !== "bash") return { ok: true };

  const command = commandArgument(requestedCall.arguments);
  if (!command) return { ok: true };

  if (isBrowserTaskShellMisroute(command, toolSelectionPromptText)) {
    const hasMcp = selectedToolNames.includes("mcp");
    return {
      ok: false,
      code: "browser_task_shell_open_misroute",
      reason: hasMcp
        ? "browser67/tmwd_browser task tried to use bash/system browser instead of the selected mcp gateway"
        : "browser67/tmwd_browser task tried to use bash/system browser while no browser MCP tool was selected",
      command,
      errors: [
        "macOS `open`, `open -a ...`, `osascript`, `xdg-open`, `start`, and `python -m webbrowser` use the system/default browser or a normal app launch, not browser67/tmwd_browser managed Chrome/Edge.",
        "Probing `which browser67`, `npm ls -g browser67`, or `ls ~/.browser67` does not execute the configured Pi MCP gateway.",
      ],
    };
  }

  if (startsWithPowerShellInvoker(command)) {
    if (hasUnquotedWindowsBackslashPath(command)) {
      return {
        ok: false,
        code: "windows_path_escaping_in_bash",
        reason: "bash will consume unquoted Windows backslashes before PowerShell receives the script path",
        command,
        errors: [
          "The bash tool receives POSIX shell text. In an unquoted bash argument, .\\scripts\\file.ps1 can become .scriptsfile.ps1.",
          "When invoking PowerShell from bash, use ./scripts/file.ps1, or quote/escape the Windows path.",
        ],
      };
    }
    return { ok: true };
  }

  if (hasRawPowerShellSyntax(command)) {
    return {
      ok: false,
      code: "powershell_syntax_in_bash",
      reason: "the bash tool was asked to execute raw PowerShell syntax",
      command,
      errors: [
        "PowerShell cmdlets such as Get-ChildItem, Select-Object, Where-Object, and -ErrorAction are not bash syntax.",
        "Use bash-compatible commands, or invoke powershell.exe/pwsh explicitly with -NoProfile -Command/-File.",
      ],
    };
  }

  return { ok: true };
}
