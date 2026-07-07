# Changelog

## [0.10.0]

- Initial npm manager CLI for pi-67.
- Adds cross-platform `pi-67` and `pi67` commands.
- Preserves user configuration and theme choices by default.
- Provides safe update, doctor, smoke, xtalpi, themes, skills, external, status,
  report, and version entrypoints.
- Reports npm manager update availability during `pi-67 update --check` and
  exposes explicit `pi-67 self-update`.
- Adds `pi-67 publish-check` for npm publish readiness and Trusted Publishing
  workflow validation.
- Adds `pi-67 manifest` for read-only package, extension, theme, shared skill,
  external repo, and preserved runtime config ownership reporting.
- Adds `pi-67 manifest --validate` for standalone extension-registry policy
  validation.
- Adds `pi-67 update --strict-shared-skills` forwarding for Bash and Windows
  PowerShell parity checks without changing the default preserve-user-skills
  behavior.
- Adds explicit `actions`, `blocked`, and `warnings` fields to
  `pi-67 update --check --json`, including planned writes, preserved paths,
  strict shared-skill blockers, and dirty external-repo blockers.
- Gates publish readiness on the ownership manifest so package, extension,
  theme, shared-skill, external-repo, and runtime-config policies cannot drift
  silently before npm publish.
- Centralizes extension-registry policy validation in a reusable library with
  self-tests for duplicate ids, missing smoke gates, forbidden behavior,
  unsupported patch modes, theme drift, shared-skill drift, dirty external-repo
  drift, and unregistered managed extensions.
- Gates real publish readiness on npm scope visibility, so a missing package
  namespace fails before the final `npm publish` step with a clear repair path.
