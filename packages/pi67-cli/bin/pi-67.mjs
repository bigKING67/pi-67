#!/usr/bin/env node

import { main } from "../src/cli.mjs";
import { CliError } from "../src/lib/output.mjs";

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof CliError) {
    console.error(`ERROR ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error?.stack || String(error));
  process.exit(1);
});
