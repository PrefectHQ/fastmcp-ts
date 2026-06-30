# Release pipeline design — Changesets + GitHub Actions + npm

**Date:** 2026-06-30
**Repo:** `PrefectHQ/fastmcp-ts`
**Package:** `@prefecthq/fastmcp-ts` (single package, public, scoped)
**Status:** Approved design, pending spec review

## Problem

The repo has no documented release process. The only artifact is a
`"release": "np --tag alpha"` script in `package.json`. As a result, the three
sources of truth have drifted apart:

- **git tags:** `v0.0.2`, `v0.0.2-alpha.0`, `v0.0.3`, `v0.0.4`
- **npm versions:** `0.0.2-alpha.0`, `0.0.2`, `0.0.4` — `v0.0.3` was tagged in
  git but never published
- **npm dist-tags:** `latest: 0.0.4`, `alpha: 0.0.2` — despite the script
  saying `--tag alpha`, `0.0.4` actually landed on `latest`

We want a process that lets maintainers release **often and easily** (one-click)
while retaining **deliberate control** over when to cut a release and at what
bump level (patch/minor/major). Every release must produce a matched git tag,
npm version, and GitHub Release so the three can never drift again.

## Decision summary

| Decision | Choice |
|----------|--------|
| Release driver | **Changesets** (`@changesets/cli` + `changesets/action`) |
| Trigger | Push to `main`; release gated behind merging the bot's "Version Packages" PR |
| npm dist-tag | **`latest`** (default). `0.0.x` semver already signals pre-production; keep installs easy. |
| npm auth | **Trusted Publishing (OIDC) + provenance** — no stored `NPM_TOKEN` |
| Changelog | `@changesets/changelog-github` (PR + author links) |
| Contributor docs | New `CONTRIBUTING.md` |
| Maintainer docs | New `RELEASING.md` |
| Orphan `v0.0.3` git tag | Leave as-is |

## How releasing will work

1. A contributor opens a PR and adds a changeset: `npx changeset` → choose bump
   level (patch / minor / major) → write a one-line summary. The generated
   `.changeset/*.md` file is committed with the PR.
2. On merge to `main`, the **Release workflow** runs and does one of two things:
   - **Accumulate:** if unreleased changesets exist, it opens/updates a
     bot-maintained **"Version Packages" PR** that bumps `package.json`,
     regenerates `CHANGELOG.md`, and deletes the consumed changeset files.
   - **Publish:** if the "Version Packages" PR was just merged (version already
     bumped, no changesets left), it builds, publishes to npm on `latest` with
     provenance, pushes the `v<version>` git tag, and creates a **GitHub
     Release** with the changelog notes.
3. **Cutting a release = merging one PR.** The bump level was chosen in the
   changeset, and the maintainer controls timing by choosing when to merge the
   version PR. One merge yields a matched git tag + npm version + GitHub Release.

## Files added / changed

### Added
- `.changeset/config.json`:
  - `baseBranch: "main"`
  - `access: "public"` (required to publish the scoped `@prefecthq/*` package)
  - `changelog: ["@changesets/changelog-github", { "repo": "PrefectHQ/fastmcp-ts" }]`
  - `commit: false` (the action commits/opens the PR)
  - default `updateInternalDependencies`/`linked`/`ignore` left at defaults (single package)
- `.changeset/README.md` — standard changesets explainer for contributors.
- `.github/workflows/release.yml` — the release workflow (see below).
- `CONTRIBUTING.md` — contributor-facing: how to add a changeset to a PR.
- `RELEASING.md` — maintainer-facing: prerequisites, how the flow works, manual
  release, promoting/pre-release escape hatches.

### Changed
- `package.json`:
  - Add devDeps: `@changesets/cli`, `@changesets/changelog-github`.
  - Remove devDep: `np`.
  - Replace `"release": "np --tag alpha"` with Changesets helper scripts:
    - `"changeset": "changeset"`
    - `"version-packages": "changeset version"`
    - `"release": "changeset publish"`
  - Keep the existing `prepublishOnly` (`build` + `test-dist` + `browser-bundle`)
    as a safety gate that still runs at publish time.

### Unchanged
- `.github/workflows/ci.yml` — test/build/e2e matrix still gates PRs.

## The release workflow (`.github/workflows/release.yml`)

- **Trigger:** `on: push: branches: [main]`.
- **Concurrency:** group on workflow + ref to avoid overlapping runs.
- **Permissions** (job-level):
  - `contents: write` — push the git tag and create the GitHub Release
  - `pull-requests: write` — open/update the "Version Packages" PR
  - `id-token: write` — npm OIDC trusted publishing
- **Steps:**
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with `node-version: '22'`, `cache: npm`, and
     `registry-url: 'https://registry.npmjs.org'`
  3. `npm install -g npm@latest` — guarantees an npm new enough for OIDC trusted
     publishing (needs ≥ 11.5.1)
  4. `npm ci`
  5. `changesets/action@v1` with:
     - `version: npx changeset version`
     - `publish: npx changeset publish`  (no `--tag` → publishes to `latest`)
     - `createGithubReleases: true`
     - `commit`/`title`: sensible defaults for the version PR
     - env: `NPM_CONFIG_PROVENANCE: "true"`, `GITHUB_TOKEN: ${{ github.token }}`
- **No `NPM_TOKEN` secret** — authentication is OIDC trusted publishing.

## dist-tag behavior (`latest`)

- Versions stay normal semver; the next cut is `0.0.5` / `0.1.0` / etc.
- `npx changeset publish` with no `--tag` publishes to `latest`, so every cut
  moves `latest` and `npm install @prefecthq/fastmcp-ts` always resolves to the
  newest release. The `0.0.x` prefix communicates pre-production status.
- The stale `alpha: 0.0.2` dist-tag becomes irrelevant. Optional one-time
  cleanup (documented, not automated):
  `npm dist-tag rm @prefecthq/fastmcp-ts alpha`.
- **Pre-release escape hatch (documented, not wired up):** if a future
  alpha/beta/rc line is wanted, Changesets pre-release mode
  (`npx changeset pre enter <tag>` … `pre exit`) produces `x.y.z-<tag>.N`
  versions that publish under a matching dist-tag. Out of scope to configure now.

## One-time manual prerequisites

These are done once, by a maintainer/org admin, outside this repo. The pipeline
cannot publish until #1 is complete. Both are tracked as checkboxes in
`RELEASING.md`.

1. **npm Trusted Publisher:** on npmjs.com → the `@prefecthq/fastmcp-ts`
   package → Settings → Trusted Publisher → add a GitHub Actions publisher for
   repo `PrefectHQ/fastmcp-ts`, workflow `release.yml`.
2. **Allow Actions to open PRs:** GitHub repo → Settings → Actions → General →
   enable "Allow GitHub Actions to create and approve pull requests".

## Reconciling current drift (one-time)

- **Orphan `v0.0.3` git tag:** leave as-is. Deleting tags that look published is
  messy and low-value; going forward, tags come only from the pipeline, so no
  new drift is introduced.
- **Stale `alpha: 0.0.2` dist-tag:** harmless; optionally remove with the
  documented one-liner above.
- No republish of historical versions.

## Documentation content

### `CONTRIBUTING.md` (contributor-facing)
- Short "Making changes" + "Add a changeset" section:
  - When a PR changes published behavior, run `npx changeset`, pick the bump
    level, write a summary, commit the file.
  - Note that omitting a changeset means the change won't trigger a release.

### `RELEASING.md` (maintainer-facing)
- One-time prerequisites (the two checkboxes above).
- How the automated flow works (accumulate → version PR → merge → publish).
- How to cut a release: merge the "Version Packages" PR.
- How to force/override a specific version (edit the version PR, or use a
  changeset of the right bump level).
- How to promote or change dist-tags manually
  (`npm dist-tag add/rm @prefecthq/fastmcp-ts@<version> <tag>`).
- The pre-release-mode escape hatch.

## Out of scope (YAGNI)

- Monorepo / multi-package configuration (single package).
- semantic-release / auto-publish on every merge (we want the manual gate).
- Automated `latest` promotion or pre-release lines (manual / documented only).
- Changes to the `ci.yml` test matrix.

## Success criteria

- Merging a "Version Packages" PR results in: a new npm version on `latest` with
  provenance, a matching `v<version>` git tag, and a GitHub Release with notes —
  all from one action, with no local steps and no stored npm token.
- Adding `npx changeset` output to a PR is the only contributor-side step.
- git tag, npm version, and GitHub Release version are always identical after a
  release.
