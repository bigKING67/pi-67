import { captureCommand } from "./shell-runner.mjs";

export function npmLatestVersion(packageName, options = {}) {
  if (options.noRemote) {
    return { skipped: true, ok: false, latestVersion: "", outdated: false, message: "remote checks skipped" };
  }
  const result = captureCommand("npm", ["view", packageName, "version", "--json"], {
    timeoutMs: options.timeoutMs || 8000,
  });
  if (!result.ok) {
    const rawMessage = result.stderr || result.error || "npm registry lookup failed";
    return {
      skipped: false,
      ok: false,
      latestVersion: "",
      outdated: false,
      message: rawMessage.includes("E404") ? "not published on npm registry yet" : compactMessage(rawMessage),
    };
  }
  const latestVersion = parseNpmVersion(result.stdout);
  return {
    skipped: false,
    ok: Boolean(latestVersion),
    latestVersion,
    outdated: latestVersion ? compareSemver(options.currentVersion || "", latestVersion) < 0 : false,
    message: latestVersion ? "" : "npm registry returned no version",
  };
}

function parseNpmVersion(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return trimmed.replace(/^"|"$/g, "");
  }
}

export function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function semverParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map((part) => Number(part));
}

function compactMessage(value) {
  const line = String(value || "").split(/\r?\n/).find((item) => item.trim()) || "";
  return line.trim().slice(0, 240);
}
