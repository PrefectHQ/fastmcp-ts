# Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc `np`-based release script with a Changesets + GitHub Actions pipeline that publishes `@prefecthq/fastmcp-ts` to npm (`latest`, with provenance via OIDC), pushes a matching git tag, and creates a GitHub Release — all from merging one bot-maintained PR.

**Architecture:** Contributors drop a `.changeset/*.md` file in their PR declaring a bump level. On push to `main`, the `changesets/action` either opens/updates a "Version Packages" PR (bumps `package.json` + writes `CHANGELOG.md`) or, once that PR is merged, publishes to npm and creates the GitHub Release. Authentication uses npm Trusted Publishing (OIDC) — no stored token.

**Tech Stack:** `@changesets/cli`, `@changesets/changelog-github`, `changesets/action@v1`, GitHub Actions, npm ≥ 11.5.1 (OIDC trusted publishing), Node 22.

**Spec:** `docs/superpowers/specs/2026-06-30-release-pipeline-design.md`

## Global Constraints

- **Do NOT run `git commit` or `git push`.** Per the repo owner's standing instruction, staging only — the maintainer makes every commit. Each task lists a suggested commit message for the maintainer to use; do not execute it.
- Package is **scoped and public** (`@prefecthq/fastmcp-ts`): changeset config MUST set `access: "public"` or publishes fail.
- Default npm dist-tag is **`latest`** — the publish command takes **no** `--tag` flag.
- Base branch is **`main`**.
- Repo slug is **`PrefectHQ/fastmcp-ts`** (used verbatim in changelog config).
- Node version in CI is **`22`**; the publish job upgrades npm (`npm install -g npm@latest`) so OIDC trusted publishing works.
- Do not add an `NPM_TOKEN` secret — auth is OIDC.
- Leave the existing `.github/workflows/ci.yml` untouched.

## Manual prerequisites (owner-handled, NOT part of these tasks)

The owner has confirmed they will do these; the pipeline cannot publish until #1 is done. They are documented as a checklist in `RELEASING.md` (Task 3).

1. npmjs.com → `@prefecthq/fastmcp-ts` → Settings → Trusted Publisher → add GitHub Actions publisher for repo `PrefectHQ/fastmcp-ts`, workflow `release.yml`.
2. GitHub repo → Settings → Actions → General → enable "Allow GitHub Actions to create and approve pull requests".

## File Structure

- Create: `.changeset/config.json` — Changesets configuration (public access, github changelog, base branch).
- Create: `.changeset/README.md` — standard contributor explainer.
- Create: `.github/workflows/release.yml` — the release workflow.
- Create: `CONTRIBUTING.md` — contributor-facing "add a changeset" guide.
- Create: `RELEASING.md` — maintainer-facing release runbook.
- Create: `.changeset/<name>.md` — initial changeset that cuts `0.0.5` on first run.
- Modify: `package.json` — add Changesets devDeps, remove `np` devDep + `np` config block, swap the `release` script for Changesets helper scripts.

---

### Task 1: Add Changesets tooling and configuration

**Files:**
- Modify: `package.json` (scripts lines 51-64, `np` config lines 65-69, devDependencies lines 70-93)
- Create: `.changeset/config.json`
- Create: `.changeset/README.md`

**Interfaces:**
- Produces: a working `.changeset/config.json` (`access: "public"`, `baseBranch: "main"`, `@changesets/changelog-github` with `repo: "PrefectHQ/fastmcp-ts"`) and npm scripts `changeset`, `version-packages`, `release` that Task 2's workflow and Task 4's verification rely on.

- [ ] **Step 1: Install Changesets dev dependencies**

This updates `package.json` and `package-lock.json` with current versions (avoids hand-guessing version numbers).

```bash
npm install -D @changesets/cli @changesets/changelog-github
```

- [ ] **Step 2: Remove the `np` dependency**

```bash
npm uninstall np
```

- [ ] **Step 3: Remove the leftover `np` config block from `package.json`**

The `np` config object is not removed by `npm uninstall`. Delete these lines (currently 65-69):

```json
  "np": {
    "branch": "main",
    "testScript": "test",
    "release": true
  },
```

- [ ] **Step 4: Replace the `release` script with Changesets helper scripts**

In `package.json` `scripts`, replace this line:

```json
    "release": "np --tag alpha"
```

with these three lines:

```json
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
```

(`prepublishOnly` is intentionally left unchanged — it still runs `build` + dist/browser checks before any publish.)

- [ ] **Step 5: Create `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": [
    "@changesets/changelog-github",
    { "repo": "PrefectHQ/fastmcp-ts" }
  ],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- [ ] **Step 6: Create `.changeset/README.md`**

```markdown
# Changesets

Hello and welcome! This folder has been automatically generated by
`@changesets/cli`, a build tool that works with multi-package repos, or
single-package repos to help you version and publish your code. You can find
the full documentation for it
[in our repository](https://github.com/changesets/changesets).

We have a quick list of common questions to get you started engaging with this
project in
[our documentation](https://github.com/changesets/changesets/blob/main/docs/common-questions.md).
```

- [ ] **Step 7: Verify the config parses and the CLI is wired up**

Run: `npx changeset status --output=/dev/stdout` (with no changesets yet it reports none to release)
Expected: command exits without a config error. Output contains `No changesets found` (or `NO packages to be bumped`). A config schema error would mean Step 5 is malformed.

Also verify the JSON is valid and scripts updated:

Run: `node -e "JSON.parse(require('fs').readFileSync('.changeset/config.json','utf8')); const p=require('./package.json'); if(p.devDependencies.np) throw new Error('np still present'); if(p.np) throw new Error('np config block still present'); if(p.scripts.release!=='changeset publish') throw new Error('release script not updated'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 8: Stage changes (maintainer commits)**

```bash
git add package.json package-lock.json .changeset/config.json .changeset/README.md
```

Suggested commit message for the maintainer:
`chore: add changesets tooling and config, remove np`

---

### Task 2: Add the release GitHub Actions workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the `.changeset/config.json` and `release`/`version-packages` scripts from Task 1.
- Produces: a workflow that, on push to `main`, runs `changesets/action@v1` to open the "Version Packages" PR or publish.

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]

# Never cancel an in-flight release; serialize instead.
concurrency:
  group: release-${{ github.workflow }}
  cancel-in-progress: false

permissions:
  contents: write        # push the git tag + create the GitHub Release
  pull-requests: write   # open/update the "Version Packages" PR
  id-token: write        # npm OIDC trusted publishing

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          registry-url: 'https://registry.npmjs.org'

      - name: Upgrade npm (OIDC trusted publishing needs >= 11.5.1)
        run: npm install -g npm@latest

      - name: Install dependencies
        run: npm ci

      - name: Create Release PR or publish to npm
        uses: changesets/action@v1
        with:
          version: npx changeset version
          publish: npx changeset publish
          title: "Version Packages"
          commit: "chore: version packages"
          createGithubReleases: true
        env:
          GITHUB_TOKEN: ${{ github.token }}
          NPM_CONFIG_PROVENANCE: "true"
```

- [ ] **Step 2: Verify the workflow YAML parses**

The repo already depends on the `yaml` package, so parse with Node:

Run: `node -e "const y=require('yaml'); const d=y.parse(require('fs').readFileSync('.github/workflows/release.yml','utf8')); if(!d.permissions['id-token']) throw new Error('missing id-token permission'); if(d.jobs.release.steps.find(s=>s.uses&&s.uses.startsWith('changesets/action'))===undefined) throw new Error('changesets action missing'); console.log('OK')"`
Expected: prints `OK`. A parse error means the YAML is malformed.

- [ ] **Step 3: (Optional) Lint with actionlint if available**

Run: `npx --yes actionlint .github/workflows/release.yml`
Expected: no output (clean), or `command not found`/network failure — in which case skip; Step 2 is the required gate.

- [ ] **Step 4: Stage changes (maintainer commits)**

```bash
git add .github/workflows/release.yml
```

Suggested commit message for the maintainer:
`ci: add changesets release workflow`

---

### Task 3: Add contributor and maintainer documentation

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `RELEASING.md`

**Interfaces:**
- Consumes: the workflow + scripts from Tasks 1-2 (documents how they are used).
- Produces: no code interface; reference docs only.

- [ ] **Step 1: Create `CONTRIBUTING.md`**

```markdown
# Contributing

Thanks for contributing to `@prefecthq/fastmcp-ts`!

## Development

- Install: `npm ci`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`

## Releasing changes: add a changeset

We use [Changesets](https://github.com/changesets/changesets) to manage
versions and the changelog. **If your PR changes published behavior, add a
changeset:**

```bash
npx changeset
```

This prompts you for:

1. The bump level — `patch` (bug fixes), `minor` (new features), or `major`
   (breaking changes). We are pre-1.0, so use your judgment; `0.0.x` already
   signals the package is pre-production.
2. A short summary that will appear in the changelog.

It writes a file under `.changeset/`. **Commit that file with your PR.**

A PR without a changeset is fine for changes that don't affect the published
package (docs, tests, CI), but note that such a PR will not trigger a release on
its own.

Releases are cut by maintainers — see [`RELEASING.md`](./RELEASING.md).
```

- [ ] **Step 2: Create `RELEASING.md`**

```markdown
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
```

- [ ] **Step 3: Verify both docs exist and are non-empty**

Run: `node -e "const fs=require('fs'); for (const f of ['CONTRIBUTING.md','RELEASING.md']) { if (fs.readFileSync(f,'utf8').trim().length < 100) throw new Error(f+' too short'); } console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 4: Stage changes (maintainer commits)**

```bash
git add CONTRIBUTING.md RELEASING.md
```

Suggested commit message for the maintainer:
`docs: add contributing and releasing guides`

---

### Task 4: Add the initial changeset to cut 0.0.5

**Files:**
- Create: `.changeset/<descriptive-name>.md` (pick any kebab-case name, e.g. `.changeset/automated-release-pipeline.md`)

**Interfaces:**
- Consumes: `.changeset/config.json` from Task 1.
- Produces: a pending `patch` changeset so the first Release workflow run opens a "Version Packages" PR bumping `0.0.4` → `0.0.5`.

- [ ] **Step 1: Create the initial changeset**

Create `.changeset/automated-release-pipeline.md`:

```markdown
---
"@prefecthq/fastmcp-ts": patch
---

Set up automated release pipeline (Changesets + GitHub Actions + npm Trusted Publishing). No runtime changes.
```

- [ ] **Step 2: Verify Changesets sees a pending 0.0.5 bump**

Run: `npx changeset status --output=/dev/stdout`
Expected: reports `@prefecthq/fastmcp-ts` will bump by `patch` (new version `0.0.5`). If it reports no changesets, the frontmatter package name or `---` fences are wrong.

- [ ] **Step 3: Stage changes (maintainer commits)**

```bash
git add .changeset/automated-release-pipeline.md
```

Suggested commit message for the maintainer:
`chore: add changeset to cut 0.0.5`

---

## Post-implementation verification (maintainer, after merge)

These confirm the end-to-end flow but require pushing to `main` and the npm
trusted-publisher setup — they are run by the maintainer, not the implementer.

1. After the prerequisite OIDC setup, merge the release-infra commits to `main`.
2. Confirm the **Release** workflow runs and opens a **"Version Packages"** PR
   bumping to `0.0.5` with a generated `CHANGELOG.md`.
3. Merge that PR. Confirm the workflow:
   - publishes `0.0.5` to npm (`npm view @prefecthq/fastmcp-ts dist-tags` shows
     `latest: 0.0.5`),
   - the package page shows a **provenance** attestation,
   - a `v0.0.5` git tag exists,
   - a **GitHub Release** `v0.0.5` exists with the changelog notes.
4. Success = git tag, npm version, and GitHub Release version are all `0.0.5`.

## Self-Review notes

- **Spec coverage:** Changesets driver (T1), `latest` dist-tag / no `--tag` (T1 config + T2 publish), OIDC + provenance (T2 permissions + env), `@changesets/changelog-github` (T1), remove `np` (T1), CONTRIBUTING + RELEASING (T3), pre-release escape hatch + manual dist-tag promotion (T3 RELEASING), orphan `v0.0.3` left as-is (no task touches tags), cut 0.0.5 (T4). All spec sections mapped.
- **Manual-only items** (OIDC trusted publisher, "allow Actions to create PRs") are owner-handled and documented, not coded — called out explicitly.
- **Commit policy:** every task stages only and defers commits to the maintainer, honoring the repo owner's standing instruction.
