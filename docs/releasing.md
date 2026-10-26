# Releasing Paparats MCP (maintainers)

Releases are driven by [Changesets](https://github.com/changesets/changesets). Versioning
and CHANGELOG generation happen in CI; **publishing to npm and tagging happen locally**
from a maintainer machine that is authenticated with npm. There are no npm credentials in
CI.

## Authoring a changeset (per PR)

```bash
yarn changeset
# Pick affected packages, bump type (patch/minor/major), and write the user-facing summary.
git add .changeset/
git commit -m "chore: changeset"
```

All four packages (`@paparats/shared`, `@paparats/cli`, `@paparats/server`,
`@paparats/indexer`) are kept on a **fixed version** — pick any one and the rest are
bumped to match.

## How a release happens

**1. CI opens a release PR (automatic).** The
[Release workflow](../.github/workflows/release.yml) runs on every push to `main`. If
pending `.changeset/*.md` files exist, it opens (or updates) a `chore: release` PR with:
version bumps in every `package.json`, regenerated per-package `CHANGELOG.md` files,
`server.json` and the client plugin manifests synced via `scripts/sync-server-json.js`,
the root `CHANGELOG.md` refreshed by `scripts/aggregate-changelog.js`, and the consumed
`.changeset/*.md` files deleted.

**2. Maintainer merges the release PR.** No further CI publish step runs.

**3. Maintainer publishes locally.** From a clean checkout of `main` after the merge:

```bash
git checkout main && git pull
yarn release:local         # or `--dry-run` to preview
```

`yarn release:local` runs `scripts/release-local.sh`, which:

- refuses to run unless you're on `main`, the tree is clean, and you're in sync with
  `origin/main`;
- refuses if any pending `.changeset/*.md` are present (means the release PR wasn't
  merged);
- reads the new version from `packages/cli/package.json`;
- builds, runs `yarn changeset publish` (skips already-published versions), then tags
  `vX.Y.Z` and pushes the tag;
- creates the GitHub Release for the tag with the version's changelog entry as notes
  (needs an authenticated `gh`). Directories such as Glama publish a new listing version on
  every GitHub Release.

**4. Downstream workflows fire on the tag.** Pushing `vX.Y.Z` triggers
[docker-publish.yml](../.github/workflows/docker-publish.yml) and
[publish-mcp.yml](../.github/workflows/publish-mcp.yml) automatically. They trigger on the tag
only, so the GitHub Release does not publish anything a second time.

## Required credentials

| Where | What                                | Purpose                                           |
| ----- | ----------------------------------- | ------------------------------------------------- |
| CI    | `GITHUB_TOKEN` (auto)               | Open/update the `chore: release` PR               |
| Local | `npm login` (or `NPM_TOKEN` in env) | `yarn changeset publish` to publish `@paparats/*` |

No npm token lives in GitHub secrets — publishing is intentionally a manual,
authenticated step.

## Manual / fallback flows

`./scripts/release-docker.sh --push` still builds and pushes the Docker images by hand if
needed (e.g. between official releases). It reads the version from `package.json`.

## Keeping public text in sync

Every change to an embedding model, a default, a port or a tool set should update, in the
same PR: `README.md`, the pages in `docs/`, `packages/cli/README.md`, `llms-install.md`, `llms.txt`, the
`description` fields in `packages/cli/package.json`, `server.json` and the client plugin
manifests (`plugin.json`, `gemini-extension.json`, `.cursor-plugin/`, `claude-plugin/`,
`grok/`). Directory listings and AI answer engines copy these texts verbatim, so a stale
line keeps being repeated long after the code changed.
