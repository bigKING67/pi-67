# @bigking67/pi-67

`@bigking67/pi-67` provides the `pi-67` command for installing, updating,
diagnosing, and repairing the pi-67 Pi Coding Agent distribution.

## Install

```bash
npm install -g @bigking67/pi-67
pi-67 install
pi-67 update
pi-67 doctor
```

Windows PowerShell uses the same public commands:

```powershell
npm install -g @bigking67/pi-67
pi-67 install
pi-67 update
pi-67 doctor
```

## Important update boundary

`pi update --extensions` is the upstream Pi command. It is not the pi-67
distribution updater.

Use this command for pi-67:

```bash
pi-67 update
```

If `pi update --extensions` was run manually, repair the pi-67 managed state:

```bash
pi-67 update --repair
```

`pi-67 update --check` reports whether the npm manager is outdated. Updating the
manager itself is explicit:

```bash
pi-67 self-update
```

If the local manager may be stale, run the latest npm package for one repair:

```bash
npx -y @bigking67/pi-67@latest update --repair
```

## Safety defaults

`pi-67 update` preserves local runtime choices:

- existing `models.json`, `auth.json`, `mcp.json`, and `image-gen.json`
- `settings.json.theme`
- user-added Pi packages
- user-added global skills
- dirty external repos such as browser67 or design-craft

Theme changes are explicit only:

```bash
pi-67 themes set gruvbox-dark
```

The manager writes lightweight state outside the repo at `~/.pi/pi67/state.json`.
It records versions, paths, theme, provider/model, and commit information; it
does not store API keys.

## Main commands

```bash
pi-67 install
pi-67 update
pi-67 update --check
pi-67 update --repair
pi-67 self-update
pi-67 publish-check
pi-67 manifest
pi-67 doctor
pi-67 smoke --quick
pi-67 status
pi-67 report
pi-67 version
pi-67 xtalpi health
pi-67 xtalpi smoke --quick
pi-67 themes current
pi-67 themes list
pi-67 skills inventory
pi-67 skills sync
pi-67 external list
```

## Ownership manifest

`pi-67 manifest` prints the distribution ownership boundary for npm packages,
runtime packages, local extensions, themes, shared skills, external repos, and
local runtime config files. It is read-only and documents what `pi-67 update`
may manage versus what it must only report.

```bash
pi-67 manifest
pi-67 manifest --json
```

`pi-67 update` preserves existing different global skills by default. Use
`pi-67 update --strict-shared-skills` only in CI/release parity checks when a
difference from the bundled `shared-skills/` baseline must block the update.

## Publish readiness

`pi-67 publish-check` validates package metadata, npm namespace visibility,
first-publish confirmation, Trusted Publishing workflow drift,
`npm pack --dry-run`, and the ownership manifest release policy. Manifest
checks gate preserved runtime config files, required local extensions,
user-managed baseline packages, theme preservation, shared-skill preservation,
and dirty external-repo blocking policy.

Maintainers can verify the npm publish path before using GitHub Actions:

```bash
pi-67 publish-check
pi-67 publish-check --json
```

The check validates version consistency, package metadata, npm scope readiness,
npm pack dry-run, and the Trusted Publishing workflow. Local `npm whoami` is
reported but is not required when publishing through GitHub Actions OIDC.
If it reports that `@bigking67` is missing, create or claim that npm user/org
scope first, or rename the package to a scope/name controlled by the maintainer.
For a package that has never been published, `publish-check --strict` blocks
until the maintainer explicitly passes `--allow-first-publish` after npm scope
and Trusted Publisher setup are complete. The GitHub workflow exposes this as
the `first_publish_confirm` input, which must equal `@bigking67/pi-67`.
