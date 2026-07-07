import fs from "node:fs";
import path from "node:path";
import { parseCommandOptions } from "../lib/args.mjs";
import { gitStatus } from "../lib/git.mjs";
import { npmLatestVersion, npmPackageScopeStatus, npmPublishTargetStatus } from "../lib/npm-registry.mjs";
import { captureCommand } from "../lib/shell-runner.mjs";
import { readCliPackageJson, readTextIfExists, packageRoot } from "../lib/paths.mjs";
import { buildDistroManifest } from "../lib/distro-manifest.mjs";
import { fail, info, keyValue, pass, printJson, section, warn } from "../lib/output.mjs";

export async function publishCheckCommand(ctx, argv) {
  const { options } = parseCommandOptions(argv, {
    bools: ["json", "no-remote", "no-pack", "quiet", "strict", "allow-first-publish"],
  });
  const json = ctx.json || options.json;
  const quiet = options.quiet;
  const noRemote = ctx.noRemote || options.noRemote;
  const noPack = options.noPack;
  const strict = options.strict;
  const report = buildPublishCheck(ctx, {
    noRemote,
    noPack,
    allowFirstPublish: options.allowFirstPublish,
  });
  if (quiet) {
    // Intentionally silent for npm lifecycle hooks; exit status carries failure.
  } else if (json) {
    printJson(report);
  } else {
    printReport(report);
  }
  if (strict && report.blockers.length > 0) {
    process.exitCode = 1;
  }
}

function buildPublishCheck(ctx, options) {
  const pkg = readCliPackageJson();
  const rootPackage = readJsonIfExists(path.join(ctx.repoRoot, "package.json")) || {};
  const versionFile = readTextIfExists(path.join(ctx.repoRoot, "VERSION")).trim();
  const workflowFile = path.join(ctx.repoRoot, ".github", "workflows", "npm-publish.yml");
  const workflow = workflowCheck(workflowFile);
  const git = fs.existsSync(ctx.repoRoot) ? gitStatus(ctx.repoRoot) : { isRepo: false };
  const registry = npmLatestVersion(pkg.name, {
    currentVersion: pkg.version,
    noRemote: options.noRemote,
    timeoutMs: 10000,
  });
  const scope = npmPackageScopeStatus(pkg.name, {
    noRemote: options.noRemote,
    timeoutMs: 10000,
  });
  const target = npmPublishTargetStatus(pkg.name, {
    noRemote: options.noRemote,
    timeoutMs: 10000,
    registry,
    scope,
    allowFirstPublish: options.allowFirstPublish,
  });
  const auth = npmAuthCheck({ noRemote: options.noRemote });
  const pack = options.noPack ? skipped("pack dry-run skipped") : npmPackCheck();
  const manifest = buildDistroManifest(ctx);
  const manifestRelease = manifestReleaseCheck(manifest);

  const checks = [
    check("package_name", pkg.name === "@bigking67/pi-67", `expected @bigking67/pi-67, got ${pkg.name}`),
    check("package_version_matches_VERSION", pkg.version === versionFile, `${pkg.version} != ${versionFile}`),
    check("root_package_version_matches_VERSION", rootPackage.version === versionFile, `${rootPackage.version || "missing"} != ${versionFile}`),
    check("bin_pi_67", pkg.bin?.["pi-67"] === "bin/pi-67.mjs", "missing pi-67 bin"),
    check("bin_pi67_alias", pkg.bin?.pi67 === "bin/pi-67.mjs", "missing pi67 alias"),
    check("publish_public", pkg.publishConfig?.access === "public", "scoped package must publish as public"),
    check("trusted_publish_workflow", workflow.ok, workflow.message),
    check("npm_scope", !scope.blocking || target.code === "first_publish_scope_probe_confirmed", scope.message),
    check("npm_publish_target", !target.blocking, target.message),
    check("distro_manifest", manifestRelease.ok, manifestRelease.message),
    check("npm_pack_dry_run", pack.ok || pack.skipped, pack.message),
  ];

  const exactVersionPublished = registry.ok && registry.latestVersion === pkg.version;
  const registryNotPublished = !registry.ok && registry.message === "not published on npm registry yet";
  const scopeMissing = Boolean(scope.blocking && target.code !== "first_publish_scope_probe_confirmed");
  const blockers = checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.message}`);
  if (exactVersionPublished) {
    blockers.push(`npm_version_already_published: ${pkg.name}@${pkg.version}`);
  }

  const warnings = [];
  if (!git.isRepo) warnings.push("repo root is not a git checkout; release provenance will be weaker");
  else if (git.dirty) warnings.push("repo has local changes; commit scoped release changes before publishing");
  if (registryNotPublished) warnings.push("npm package is not published yet; configure Trusted Publisher or do one manual first publish");
  if (scope.skipped) warnings.push("npm scope check skipped");
  else if (target.code === "first_publish_scope_probe_confirmed") {
    warnings.push(`npm scope probe did not prove ${scope.scope}; explicit first-publish confirmation lets final npm publish validate write permission`);
  }
  else if (scope.scoped && !scope.ok && !scope.blocking) warnings.push(`npm scope check did not complete: ${scope.message}`);
  if (target.skipped) warnings.push("npm publish target check skipped");
  else if (target.firstPublish && target.allowFirstPublish && target.ok) {
    warnings.push("first publish confirmation is explicit; npm still validates Trusted Publisher only during final npm publish");
  }
  if (!options.noRemote && !auth.ok) warnings.push("local npm auth is missing; this is acceptable for GitHub Trusted Publishing");
  if (registry.skipped) warnings.push("npm registry check skipped");
  if (auth.skipped) warnings.push("npm auth check skipped");
  if (pack.skipped) warnings.push("npm pack dry-run skipped");
  warnings.push(...manifestRelease.warnings);

  let status = "ready";
  if (blockers.length > 0) status = "blocked";
  else if (registryNotPublished || !auth.ok || git.dirty || registry.skipped || auth.skipped) status = "ready_with_notes";

  return {
    schema: "pi67.publish-check.v1",
    createdAt: new Date().toISOString(),
    status,
    package: {
      name: pkg.name,
      version: pkg.version,
      root: packageRoot(),
    },
    distro: {
      version: versionFile,
      rootPackageVersion: rootPackage.version || "",
    },
    paths: {
      repoRoot: ctx.repoRoot,
      agentDir: ctx.agentDir,
      workflow: workflowFile,
    },
    git,
    workflow,
    scope,
    target,
    manifest: {
      summary: manifest.summary,
      release: manifestRelease,
    },
    registry,
    auth,
    pack,
    checks,
    blockers,
    warnings,
    nextSteps: nextSteps({
      status,
      registryNotPublished,
      exactVersionPublished,
      authOk: auth.ok,
      scopeMissing,
      scopeName: scope.scope,
      packageName: pkg.name,
      firstPublishNeedsConfirmation: target.code === "first_publish_requires_confirmation",
      allowFirstPublish: target.allowFirstPublish,
    }),
  };
}

function manifestReleaseCheck(manifest) {
  const requiredPreserve = ["settings.json", "models.json", "auth.json", "mcp.json", "image-gen.json"];
  const missingPreserve = requiredPreserve.filter((file) => !manifest.runtimeFiles?.preserve?.includes(file));
  const requiredCommands = ["update", "repair", "alwaysFreshRepair", "upstreamPiExtensions"];
  const missingCommands = requiredCommands.filter((name) => !manifest.commands?.[name]);
  const missingLocalExtensions = (manifest.localExtensions || [])
    .filter((item) => item.required && !item.exists)
    .map((item) => item.name);
  const userManagedPackages = manifest.userManagedPackages || [];
  const policyProblems = [];

  if (manifest.theme?.preserveSetting !== "settings.json.theme") {
    policyProblems.push("theme preserveSetting must be settings.json.theme");
  }
  if (manifest.theme?.policy !== "install-theme-package-only-never-select-theme-on-update") {
    policyProblems.push("theme policy must preserve selected theme during update");
  }
  if (manifest.sharedSkills?.policy !== "copy-by-default-preserve-different-existing-skills-unless-strict") {
    policyProblems.push("shared skills policy must preserve existing differences unless strict");
  }
  if (manifest.externalReposPolicy?.dirtyRepo !== "preserve-and-block-update") {
    policyProblems.push("dirty external repos must block update instead of being overwritten");
  }

  const problems = [
    ...missingPreserve.map((item) => `missing preserved runtime file policy: ${item}`),
    ...missingCommands.map((item) => `missing canonical command policy: ${item}`),
    ...missingLocalExtensions.map((item) => `required local extension missing: ${item}`),
    ...userManagedPackages.map((item) => `repo baseline contains user-managed runtime package: ${item.spec}`),
    ...policyProblems,
  ];

  const warnings = [];
  if (manifest.summary?.runtimePackages === 0) {
    warnings.push("distro manifest has no runtime packages");
  }

  return {
    ok: problems.length === 0,
    message: problems.length === 0 ? "ownership manifest release policy ready" : problems.join("; "),
    problems,
    warnings,
  };
}

function workflowCheck(file) {
  const text = readTextIfExists(file);
  if (!text) return { ok: false, file, message: "npm publish workflow missing" };
  const required = [
    "workflow_dispatch",
    "id-token: write",
    "Use npm with trusted publishing support",
    "npm install -g npm@latest",
    "Validate npm publish target",
    "first_publish_confirm",
    "publish-check --strict --no-pack",
    "--allow-first-publish",
    "npm publish ./packages/pi67-cli --access public --tag",
  ];
  const missing = required.filter((fragment) => !text.includes(fragment));
  const forbidden = ["secrets.NPM_TOKEN", "NODE_AUTH_TOKEN:"].filter((fragment) => text.includes(fragment));
  const ok = missing.length === 0 && forbidden.length === 0;
  return {
    ok,
    file,
    trustedPublishing: ok,
    missing,
    forbidden,
    message: ok ? "trusted publishing workflow ready" : `workflow drift: missing=${missing.join(",") || "-"} forbidden=${forbidden.join(",") || "-"}`,
  };
}

function npmAuthCheck(options) {
  if (options.noRemote) return skipped("remote auth check skipped");
  const result = captureCommand("npm", ["whoami"], { timeoutMs: 10000 });
  return {
    skipped: false,
    ok: result.ok,
    username: result.ok ? result.stdout.trim() : "",
    message: result.ok ? "npm auth available" : compactMessage(result.stderr || result.error || "npm auth unavailable"),
  };
}

function npmPackCheck() {
  const result = captureCommand("npm", ["pack", "--dry-run", packageRoot()], { timeoutMs: 30000 });
  return {
    skipped: false,
    ok: result.ok,
    message: result.ok ? "npm pack dry-run passed" : compactMessage(result.stderr || result.error || "npm pack dry-run failed"),
    tarball: result.ok ? compactMessage(result.stdout) : "",
  };
}

function check(name, ok, message) {
  return { name, ok: Boolean(ok), message: ok ? "ok" : message };
}

function skipped(message) {
  return { skipped: true, ok: false, message };
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function nextSteps(context) {
  if (context.exactVersionPublished) {
    return [
      "Bump VERSION, root package.json, packages/pi67-cli/package.json, and changelogs before publishing again.",
    ];
  }
  const steps = [
    "GitHub Actions -> npm publish pi-67 manager -> Run workflow with dry_run=true.",
  ];
  if (context.scopeMissing) {
    steps.push(`Create or claim the npm scope ${context.scopeName} before publishing, or rename the npm package to an owned scope/name.`);
  }
  if (context.firstPublishNeedsConfirmation) {
    steps.push(`After npm scope and Trusted Publisher are configured, rerun with --allow-first-publish or set the workflow first_publish_confirm input to ${context.packageName}.`);
  }
  if (context.registryNotPublished) {
    steps.push(`Configure npm Trusted Publisher for ${context.packageName}, or do one manual npm-authenticated first publish.`);
  }
  steps.push("After dry-run succeeds, rerun the workflow with dry_run=false.");
  if (!context.authOk) {
    steps.push("Local npm login is optional when using Trusted Publishing; use `npm adduser` only for manual fallback publish.");
  }
  return steps;
}

function printReport(report) {
  section("pi-67 npm publish check");
  keyValue("Package", `${report.package.name}@${report.package.version}`);
  keyValue("Distro", report.distro.version || "unknown");
  keyValue("Workflow", report.workflow.ok ? "trusted publishing ready" : report.workflow.message);
  keyValue("npm scope", report.scope.message);
  keyValue("Publish target", report.target.message);
  keyValue("Manifest", report.manifest.release.ok ? "ownership policy ready" : report.manifest.release.message);
  keyValue("Registry", registryLabel(report.registry));
  keyValue("npm auth", report.auth.skipped ? "skipped" : report.auth.ok ? report.auth.username : "not logged in");
  keyValue("Pack", report.pack.skipped ? "skipped" : report.pack.ok ? "passed" : report.pack.message);
  keyValue("Git", report.git?.isRepo ? `${report.git.commit || "unknown"}${report.git.dirty ? " dirty" : ""}` : "not a git repo");
  section("Checks");
  for (const item of report.checks) {
    if (item.ok) pass(item.name);
    else fail(`${item.name}: ${item.message}`);
  }
  for (const item of report.warnings) warn(item);
  section("Next steps");
  for (const item of report.nextSteps) info(item);
  section("Result");
  if (report.status === "blocked") fail(report.blockers.join("; "));
  else if (report.status === "ready_with_notes") warn("publish path is structurally ready; see notes above");
  else pass("publish path ready");
}

function registryLabel(registry) {
  if (registry.skipped) return "skipped";
  if (registry.ok) return `latest ${registry.latestVersion}${registry.outdated ? " (manager older)" : ""}`;
  return registry.message || "unknown";
}

function compactMessage(value) {
  return redactLocalPaths(String(value || ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 240);
}

function redactLocalPaths(value) {
  const homeCandidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : "",
  ].filter(Boolean);
  let output = value;
  for (const home of homeCandidates) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "g"), "<home>");
  }
  return output;
}
