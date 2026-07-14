export function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? (fenceMatch[1] ?? "").trim() : trimmed;
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
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      text += char;
      continue;
    }

    if (value[index + 1] === "\\") {
      text += "\\\\";
      index += 1;
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
