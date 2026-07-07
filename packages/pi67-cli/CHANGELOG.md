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
