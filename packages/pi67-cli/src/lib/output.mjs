export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function section(title) {
  process.stdout.write(`\n${title}\n`);
}

export function pass(message) {
  process.stdout.write(`  PASS ${message}\n`);
}

export function warn(message) {
  process.stdout.write(`  WARN ${message}\n`);
}

export function info(message) {
  process.stdout.write(`  INFO ${message}\n`);
}

export function fail(message) {
  process.stdout.write(`  FAIL ${message}\n`);
}

export function keyValue(label, value) {
  process.stdout.write(`${label.padEnd(18)}: ${value ?? ""}\n`);
}
