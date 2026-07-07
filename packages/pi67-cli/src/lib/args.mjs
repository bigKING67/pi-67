import { CliError } from "./output.mjs";

const VALUE_GLOBALS = new Set(["agent-dir", "repo-root", "skills-dir", "packages-dir"]);
const BOOL_GLOBALS = new Set(["json", "dry-run", "yes", "help", "no-remote"]);

export function splitGlobalArgs(argv) {
  const globals = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h") {
      globals.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

    if (VALUE_GLOBALS.has(name)) {
      const value = inlineValue ?? argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`--${name} requires a value`, 2);
      }
      globals[toCamel(name)] = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (BOOL_GLOBALS.has(name)) {
      globals[toCamel(name)] = true;
      continue;
    }
    rest.push(arg);
  }
  return { globals, rest };
}

export function parseCommandOptions(argv, spec = {}) {
  const strings = new Set(spec.strings || []);
  const bools = new Set(spec.bools || []);
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const key = toCamel(name);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

    if (strings.has(name)) {
      const value = inlineValue ?? argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`--${name} requires a value`, 2);
      }
      options[key] = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (bools.has(name)) {
      options[key] = true;
      continue;
    }
    throw new CliError(`unknown option: --${name}`, 2);
  }

  return { options, positionals };
}

export function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
