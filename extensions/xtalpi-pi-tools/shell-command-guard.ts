import type { JsonObject } from "./protocol.ts";

export type ShellCommandGuardCode =
  | "powershell_syntax_in_bash"
  | "windows_path_escaping_in_bash";

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

export function validateShellCommandRequest(requestedCall: ToolCallRequest): ShellCommandGuardResult {
  if (requestedCall.name !== "bash") return { ok: true };

  const command = commandArgument(requestedCall.arguments);
  if (!command) return { ok: true };

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
