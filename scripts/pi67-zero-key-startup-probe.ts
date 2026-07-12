import { writeFileSync } from "node:fs";

const MARKER_ENV = "PI67_STARTUP_PROBE_MARKER";

export default function pi67ZeroKeyStartupProbe(pi: any) {
  pi.on("session_start", (event: { reason?: string }, ctx: { shutdown: () => void }) => {
    const markerPath = process.env[MARKER_ENV];
    if (!markerPath) {
      throw new Error(`${MARKER_ENV} is required`);
    }

    writeFileSync(
      markerPath,
      `${JSON.stringify({ schema: "pi67-startup-probe/v1", reason: event.reason ?? null })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    ctx.shutdown();
    // The probe must never leave a headless CI runner waiting on the TUI.
    setTimeout(() => process.exit(0), 250);
  });
}
