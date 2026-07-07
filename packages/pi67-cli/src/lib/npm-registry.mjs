import { captureCommand } from "./shell-runner.mjs";

const DEFAULT_REGISTRY_BASE_URL = "https://registry.npmjs.org";

export async function npmLatestVersion(packageName, options = {}) {
  if (options.noRemote) {
    return { skipped: true, ok: false, latestVersion: "", outdated: false, message: "remote checks skipped" };
  }
  const result = await npmRegistryLatestPayload(packageName, options);
  if (!result.ok) {
    return {
      skipped: false,
      ok: false,
      latestVersion: "",
      outdated: false,
      message: result.message,
    };
  }
  const latestVersion = parseNpmLatestPayload(result.payload);
  return {
    skipped: false,
    ok: Boolean(latestVersion),
    latestVersion,
    outdated: latestVersion ? compareSemver(options.currentVersion || "", latestVersion) < 0 : false,
    message: latestVersion ? "" : "npm registry returned no version",
  };
}

export function npmRegistryPackageUrl(packageName, options = {}) {
  const baseUrl = String(options.registryBaseUrl || DEFAULT_REGISTRY_BASE_URL).replace(/\/+$/, "");
  const encodedPackage = encodeURIComponent(String(packageName || "")).replace(/^%40/, "@");
  return `${baseUrl}/${encodedPackage}/latest`;
}

async function npmRegistryLatestPayload(packageName, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    clearTimeout(timeout);
    return {
      ok: false,
      message: "npm registry lookup failed: fetch unavailable in this Node runtime",
    };
  }
  try {
    const response = await fetchImpl(npmRegistryPackageUrl(packageName, options), {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "pi-67-manager",
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        message: response.status === 404
          ? "not published on npm registry yet"
          : `npm registry lookup failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      };
    }
    try {
      return { ok: true, payload: await response.json() };
    } catch {
      return { ok: false, message: "npm registry returned invalid JSON" };
    }
  } catch (error) {
    return {
      ok: false,
      message: registryErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function npmPackageScopeStatus(packageName, options = {}) {
  const scope = packageScope(packageName);
  if (!scope) {
    return {
      skipped: false,
      ok: true,
      blocking: false,
      scoped: false,
      scope: "",
      code: "unscoped",
      message: "unscoped npm package",
      probes: [],
    };
  }
  if (options.noRemote) {
    return {
      skipped: true,
      ok: false,
      blocking: false,
      scoped: true,
      scope,
      code: "skipped",
      message: "remote scope check skipped",
      probes: [],
    };
  }

  const scopeName = scope.slice(1);
  const accessResult = captureCommand("npm", ["access", "list", "packages", scope, "--json"], {
    timeoutMs: options.timeoutMs || 8000,
  });
  const accessProbe = npmProbe("npm access list packages", accessResult);
  if (accessResult.ok) {
    const packages = parseJsonObject(accessResult.stdout);
    const packageCount = packages ? Object.keys(packages).length : 0;
    return {
      skipped: false,
      ok: true,
      blocking: false,
      scoped: true,
      scope,
      code: "scope_visible",
      message: `npm scope ${scope} is visible via npm access list packages (${packageCount} packages)`,
      probes: [accessProbe],
    };
  }

  const accessMessage = accessResult.stderr || accessResult.stdout || accessResult.error || "npm scope lookup failed";
  const missing = isMissingNpmResource(accessMessage);
  const forbidden = isForbiddenNpmResource(accessMessage);
  if (missing || forbidden) {
    return {
      skipped: false,
      ok: false,
      blocking: true,
      scoped: true,
      scope,
      code: missing ? "scope_missing" : "scope_forbidden",
      message: missing
        ? `npm scope ${scope} was not found; create/claim the npm user or org before publishing`
        : `npm scope ${scope} is not accessible to this publisher; verify npm ownership, collaborators, or trusted publisher setup`,
      probes: [accessProbe],
    };
  }

  const orgResult = captureCommand("npm", ["org", "ls", scopeName, "--json"], {
    timeoutMs: options.timeoutMs || 8000,
  });
  const orgProbe = npmProbe("npm org ls", orgResult);
  if (orgResult.ok) {
    const orgPackages = parseJsonObject(orgResult.stdout);
    const packageCount = orgPackages ? Object.keys(orgPackages).length : 0;
    return {
      skipped: false,
      ok: true,
      blocking: false,
      scoped: true,
      scope,
      code: "scope_org_visible_access_probe_inconclusive",
      message: `npm scope ${scope} is visible via npm org ls; package-access probe was inconclusive (${packageCount} org entries)`,
      probes: [accessProbe, orgProbe],
    };
  }

  const orgMessage = orgResult.stderr || orgResult.stdout || orgResult.error || "npm scope lookup failed";
  const orgMissing = isMissingNpmResource(orgMessage);
  return {
    skipped: false,
    ok: false,
    blocking: orgMissing,
    scoped: true,
    scope,
    code: orgMissing ? "scope_missing" : "scope_probe_failed",
    message: orgMissing
      ? `npm scope ${scope} was not found; create/claim the npm user or org before publishing`
      : compactMessage(accessMessage),
    probes: [accessProbe, orgProbe],
  };
}

export function npmPublishTargetStatus(packageName, options = {}) {
  if (options.noRemote) {
    return {
      skipped: true,
      ok: false,
      blocking: false,
      packageName,
      firstPublish: false,
      allowFirstPublish: Boolean(options.allowFirstPublish),
      code: "skipped",
      message: "remote publish target check skipped",
    };
  }

  const registry = options.registry || {};
  const scope = options.scope || npmPackageScopeStatus(packageName, options);
  const registryLookupFailed = !registry.skipped && !registry.ok && registry.message !== "not published on npm registry yet";
  const firstPublish = !registry.skipped && !registry.ok && registry.message === "not published on npm registry yet";

  if (registryLookupFailed) {
    return {
      skipped: false,
      ok: false,
      blocking: true,
      packageName,
      firstPublish: false,
      allowFirstPublish: Boolean(options.allowFirstPublish),
      code: "registry_lookup_failed",
      message: `npm registry lookup failed for ${packageName}: ${compactMessage(registry.message)}`,
    };
  }

  if (scope.blocking && firstPublish && options.allowFirstPublish && scope.code === "scope_missing") {
    return {
      skipped: false,
      ok: true,
      blocking: false,
      packageName,
      firstPublish: true,
      allowFirstPublish: true,
      code: "first_publish_scope_probe_confirmed",
      message: `first publish for ${packageName} explicitly confirmed; npm publish remains the authority for new-scope write permission`,
    };
  }

  if (scope.blocking) {
    return {
      skipped: false,
      ok: false,
      blocking: true,
      packageName,
      firstPublish,
      allowFirstPublish: Boolean(options.allowFirstPublish),
      code: scope.code || "scope_blocked",
      message: scope.message,
    };
  }

  if (firstPublish && !options.allowFirstPublish) {
    return {
      skipped: false,
      ok: false,
      blocking: true,
      packageName,
      firstPublish: true,
      allowFirstPublish: false,
      code: "first_publish_requires_confirmation",
      message: `first publish for ${packageName} requires explicit --allow-first-publish after npm scope and Trusted Publisher are configured`,
    };
  }

  if (firstPublish) {
    return {
      skipped: false,
      ok: true,
      blocking: false,
      packageName,
      firstPublish: true,
      allowFirstPublish: true,
      code: "first_publish_confirmed",
      message: `first publish for ${packageName} explicitly confirmed; npm will validate Trusted Publisher only during npm publish`,
    };
  }

  return {
    skipped: false,
    ok: true,
    blocking: false,
    packageName,
    firstPublish: false,
    allowFirstPublish: Boolean(options.allowFirstPublish),
    code: "published_package_target_ready",
    message: `npm publish target ${packageName} is already present on the registry`,
  };
}

function packageScope(packageName) {
  const match = String(packageName || "").match(/^(@[^/]+)\//);
  return match ? match[1] : "";
}

function parseNpmLatestPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  return typeof payload.version === "string" ? payload.version.trim() : "";
}

function registryErrorMessage(error) {
  if (error?.name === "AbortError") return "npm registry lookup timed out";
  return `npm registry lookup failed: ${compactMessage(error?.message || error || "unknown error")}`;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "").trim() || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function npmProbe(name, result) {
  return {
    name,
    ok: Boolean(result.ok),
    status: typeof result.status === "number" ? result.status : null,
    message: result.ok ? "ok" : compactMessage(result.stderr || result.stdout || result.error || "failed"),
  };
}

function isMissingNpmResource(message) {
  const value = String(message || "");
  return value.includes("Scope not found") || value.includes("E404") || value.includes("Not Found");
}

function isForbiddenNpmResource(message) {
  const value = String(message || "");
  return value.includes("E403") || value.includes("Forbidden");
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
