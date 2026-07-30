import path from "node:path";

export function upstreamPiInvocation(repoRoot, executableOverride = "") {
  if (executableOverride) {
    return {
      command: executableOverride,
      args: [],
      shell: process.platform === "win32",
    };
  }

  return {
    command: process.execPath,
    args: [path.join(
      repoRoot,
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    )],
    shell: false,
  };
}
