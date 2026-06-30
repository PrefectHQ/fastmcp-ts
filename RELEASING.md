# Releasing

`@prefecthq/fastmcp-ts` is released with [Changesets](https://github.com/changesets/changesets)
and GitHub Actions. Publishing to npm uses **Trusted Publishing (OIDC)** with
provenance — there is no npm token stored anywhere.

## One-time setup (maintainers / org admins)

- [ ] On npmjs.com → the `@prefecthq/fastmcp-ts` package → **Settings → Trusted
      Publisher** → add a GitHub Actions publisher for repo
      `PrefectHQ/fastmcp-ts`, workflow `release.yml`. **The pipeline cannot
      publish until this is done.**
- [ ] GitHub repo → **Settings → Actions → General** → enable "Allow GitHub
      Actions to create and approve pull requests".

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

**To cut a release: merge the open "Version Packages" PR.** That's the only
step. The version, git tag, npm publish, and GitHub Release all come from that
one merge, so they can never drift.

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
