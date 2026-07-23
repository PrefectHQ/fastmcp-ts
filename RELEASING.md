# Releasing

`@prefecthq/fastmcp-ts` is released with [Changesets](https://github.com/changesets/changesets)
and GitHub Actions. Publishing to npm uses **Trusted Publishing (OIDC)** with
provenance.

## How a release happens

1. PRs land on `main`, each carrying a changeset (see
   [`CONTRIBUTING.md`](./CONTRIBUTING.md)).
2. The **Release** workflow (`.github/workflows/release.yml`) runs on every push
   to `main`:
   - If unreleased changesets exist, it opens/updates a **"Version Packages"**
     PR that bumps `package.json` and regenerates `CHANGELOG.md`.
   - When you **merge that PR**, the workflow publishes to npm (dist-tag
     `latest`, with provenance), pushes the matching `v<version>` git tag, and
     creates a **GitHub Release** with the changelog notes.

**To cut a release: merge the open "Version Packages" PR.**

## Choosing the version

The version is computed from the bump levels in the pending changesets (the
highest wins): `patch` → `0.0.x`, `minor` → `0.x.0`, `major` → `x.0.0`. To force
a specific version, edit `package.json` in the "Version Packages" PR before
merging, or add a changeset of the desired level.

## dist-tags

Releases publish to **`latest`**, so `npm install @prefecthq/fastmcp-ts` always
gets the newest cut. The `0.0.x` version line signals the package is
pre-production.

To move or remove a dist-tag manually:

```bash
npm dist-tag add @prefecthq/fastmcp-ts@<version> latest
npm dist-tag rm  @prefecthq/fastmcp-ts <tag>
```

(The legacy `alpha` dist-tag from the old process can be removed with
`npm dist-tag rm @prefecthq/fastmcp-ts alpha`.)

## Pre-release lines (alpha/beta/rc) — escape hatch

Not configured by default. If you ever need a pre-release line, use Changesets
pre-release mode:

```bash
npx changeset pre enter next   # subsequent releases become x.y.z-next.N on the `next` dist-tag
# ... merge Version Packages PRs as usual ...
npx changeset pre exit         # return to normal releases
```

See the [Changesets prereleases docs](https://github.com/changesets/changesets/blob/main/docs/prereleases.md).

## Current pre-release line: `rc` (1.0.0)

The repository is in Changesets **pre mode** on the `rc` tag. It ships the
`1.0.0-rc.*` release candidates for FastMCP 1.0. `.changeset/pre.json` records
this state; it must stay committed on the release branch for CI to build
prerelease versions.

How it works:

- Each merged "Version Packages" PR cuts the next candidate — `1.0.0-rc.0`,
  then `1.0.0-rc.1`, and so on. The counter starts at `0`.
- `changeset publish` sends each candidate to the **`rc`** npm dist-tag, not
  `latest`. Pre mode selects the tag from `pre.json` on its own, because the
  package already has regular (non-prerelease) releases on npm. The release
  workflow passes no `--tag`, so no change to CI is needed.
- **`latest` stays on the 0.x line** while the `rc` line runs. A plain
  `npm install @prefecthq/fastmcp-ts` still gets the current 0.x release. To
  try a candidate, install `@prefecthq/fastmcp-ts@rc`.
- The 0.x line is in maintenance during the `rc` line and receives critical
  fixes only.

How it ends — cut stable 1.0.0:

```bash
npx changeset pre exit    # leave pre mode; commit the pre.json change
```

After `pre exit`, the next "Version Packages" PR versions the pending
changesets as a normal release: `1.0.0` stable, published to **`latest`**.
That is the point where `latest` moves off the 0.x line.
