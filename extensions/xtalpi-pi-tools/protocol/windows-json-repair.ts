export function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? (fenceMatch[1] ?? "").trim() : trimmed;
}

export function looksLikeMalformedWindowsBashJsonAction(value: string): boolean {
  const cleaned = stripMarkdownFence(value);
  return /^\s*\{[\s\S]*\}\s*$/.test(cleaned) &&
    /"kind"\s*:\s*"tool_call"/.test(cleaned) &&
    /"name"\s*:\s*"bash"/.test(cleaned) &&
    /"arguments"\s*:\s*\{/.test(cleaned) &&
    /"command"\s*:\s*"/.test(cleaned) &&
    /[A-Za-z]:\\/.test(cleaned);
}

export function hasEvenBackslashPrefix(value: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i -= 1) {
    count += 1;
  }
  return count % 2 === 0;
}

export function escapeLikelyWindowsPathStringContent(value: string): { text: string; changed: boolean } {
  if (!/[A-Za-z]:\\/.test(value)) return { text: value, changed: false };

  let changed = false;
  let text = "";
  let inWindowsPath = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (!inWindowsPath &&
      /[A-Za-z]/.test(char ?? "") &&
      value[index + 1] === ":" &&
      value[index + 2] === "\\") {
      text += `${char}:`;
      index += 1;
      inWindowsPath = true;
      continue;
    }

    if (char !== "\\") {
      text += char;
      continue;
    }

    if (value[index + 1] === "\\") {
      text += "\\\\";
      index += 1;
    } else if (!inWindowsPath || value[index + 1] === '"') {
      // Preserve valid JSON escapes outside the path and the escaped shell
      // quote that commonly terminates a quoted Windows path.
      text += `\\${value[index + 1] ?? ""}`;
      if (value[index + 1] === '"') inWindowsPath = false;
      index += value[index + 1] === undefined ? 0 : 1;
    } else {
      text += "\\\\";
      changed = true;
    }
  }

  return { text, changed };
}

function escapeLikelyWindowsPathBackslashesInJsonStrings(value: string): { text: string; changed: boolean } {
  let changed = false;
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '"') {
      text += char;
      continue;
    }

    let content = "";
    let end = index + 1;
    for (; end < value.length; end += 1) {
      const inner = value[end];
      if (inner === '"' && hasEvenBackslashPrefix(value, end)) break;
      content += inner;
    }
    if (end >= value.length) {
      text += `"${content}`;
      index = value.length;
      break;
    }

    const repaired = escapeLikelyWindowsPathStringContent(content);
    text += `"${repaired.text}"`;
    changed = changed || repaired.changed;
    index = end;
  }

  return { text, changed };
}

export function parseJsonWithLikelyWindowsPathRepair(raw: string): {
  value: unknown;
  jsonText: string;
  warnings: string[];
} {
  const cleaned = stripMarkdownFence(raw);
  const repaired = escapeLikelyWindowsPathBackslashesInJsonStrings(cleaned);
  const candidate = repaired.changed ? repaired.text : cleaned;
  return {
    value: JSON.parse(candidate),
    jsonText: candidate,
    warnings: repaired.changed ? ["repaired likely Windows path backslashes in JSON strings"] : [],
  };
}
