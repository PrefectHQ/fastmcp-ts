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
