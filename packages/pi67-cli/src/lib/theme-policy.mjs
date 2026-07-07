import fs from "node:fs";
import path from "node:path";
import { readJsonFileIfExists } from "./config-json.mjs";

const THEME_PACKAGE = "@victor-software-house/pi-curated-themes";

export function currentTheme(ctx) {
  const settings = readJsonFileIfExists(path.join(ctx.agentDir, "settings.json")) || {};
  return settings.theme || "";
}

export function themeDirs(ctx) {
  return [
    path.join(ctx.agentDir, "npm", "node_modules", THEME_PACKAGE, "themes"),
    path.join(ctx.repoRoot, "npm", "node_modules", THEME_PACKAGE, "themes"),
  ];
}

export function listThemes(ctx) {
  const names = new Set();
  for (const dir of themeDirs(ctx)) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        names.add(entry.name.replace(/\.json$/, ""));
      }
    }
  }
  return [...names].sort();
}

export function hasTheme(ctx, name) {
  return listThemes(ctx).includes(name);
}
