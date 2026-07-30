import fs from "node:fs";
import path from "node:path";
import { packageRoot, readCliPackageJson, readTextIfExists } from "./paths.mjs";
import { readCurrentRelease } from "./release-store.mjs";

export function captureOperationSnapshot(ctx, { sourceRoot, settings = {} } = {}) {
  const pkg = readCliPackageJson();
  const currentRelease = readCurrentRelease(ctx);
  const currentReleaseExists = Boolean(
    currentRelease?.releasePath && fs.existsSync(currentRelease.releasePath),
  );
  const targetRoot = path.resolve(sourceRoot || ctx.repoRoot);
  const agentExists = fs.existsSync(ctx.agentDir);
  const legacySourceCheckout = agentExists && fs.existsSync(path.join(ctx.agentDir, ".git"));
  const currentVersion = currentRelease?.version || (
    legacySourceCheckout ? readTextIfExists(path.join(ctx.agentDir, "VERSION")).trim() : ""
  );
  const targetVersion = readTextIfExists(path.join(targetRoot, "VERSION")).trim();

  return {
    schema: "pi67.operation-snapshot.v1",
    capturedAt: new Date().toISOString(),
    manager: {
      package: pkg.name,
      version: pkg.version,
      root: packageRoot(),
    },
    current: {
      kind: currentRelease
        ? (currentReleaseExists ? "immutable-release" : "broken-release-pointer")
        : (legacySourceCheckout ? "source-checkout" : (agentExists ? "unmanaged" : "absent")),
      activated: currentReleaseExists,
      version: currentVersion,
      releasePath: currentRelease?.releasePath || "",
    },
    target: {
      version: targetVersion,
      sourceRoot: targetRoot,
    },
    live: {
      agentDir: ctx.agentDir,
      stateDir: ctx.stateDir,
      exists: agentExists,
      defaultProvider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : "",
      defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : "",
      theme: typeof settings.theme === "string" ? settings.theme : "",
    },
  };
}
