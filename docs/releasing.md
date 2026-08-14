# Releasing

Claude DevTools uses [Changesets](https://github.com/changesets/changesets) for
SemVer decisions and changelog generation, and
[changesets/action](https://github.com/changesets/action) for release pull
requests and npm publishing.

## One-time setup

1. Confirm that the `@oneyoung` npm organization or user scope exists and that
   the maintainer can publish `@oneyoung/claude-devtools`.
2. In GitHub, open **Settings → Actions → General** and enable **Allow GitHub
   Actions to create and approve pull requests**.
3. Bootstrap the package once with a granular npm automation token stored as
   the `NPM_TOKEN` GitHub Actions secret. Merge the generated release pull
   request; the release workflow publishes the first version.
4. On npm, open the package's **Settings → Trusted Publisher** and configure:
   - provider: GitHub Actions
   - owner: `YoungCollect`
   - repository: `claude-devtools`
   - workflow: `release.yml`
   - allowed action: `npm publish`
5. Run one release through trusted publishing, then remove `NPM_TOKEN` from
   GitHub. Optionally disallow token-based publishing in npm package settings.

The release job runs on a GitHub-hosted runner with `id-token: write` and npm
11.5.1, so npm can exchange GitHub's OIDC identity for a short-lived publishing
credential. Public packages published this way also receive npm provenance.

## Every change

Changesets are derived from commit subjects, so the default path is to write a
[Conventional Commit](https://www.conventionalcommits.org/) and nothing else.
`scripts/changeset-from-commits.ts` maps the type to a SemVer bump:

| Commit type                            | Bump      |
| -------------------------------------- | --------- |
| `feat:`                                | `minor`   |
| `fix:`, `perf:`, `refactor:`, `revert:` | `patch`   |
| `<type>!:` or `BREAKING CHANGE:` body  | `major`   |
| `docs:`, `chore:`, `test:`, `ci:`, `build:`, `style:` | skipped |
| anything without a recognized type     | skipped   |

The commit subject becomes the `CHANGELOG.md` entry, so write subjects for
package users. Preview what the next release would contain:

```bash
pnpm changeset:auto --dry-run   # classify commits since the last release
pnpm changeset:auto --all       # also include docs/chore/test/ci/build/style
```

`--dry-run` is the normal local invocation. Without it the generator writes one
`.changeset/auto-<short-sha>.md` per releasable commit; those files are
gitignored scratch output, because the release workflow regenerates them on
every push to `main`. Remove them with `rm .changeset/auto-*.md`.

Hand-written changesets still work and are merged with the generated ones. Use
`pnpm changeset` when the changelog needs wording the commit subject cannot
carry, or when a commit's type understates its release impact.

## Automated release lifecycle

1. Any commit merges into `main`.
2. `release.yml` runs `pnpm changeset:auto`, which writes one changeset per
   releasable commit since the last `chore: release package` commit. Generated
   changesets stay in the runner's working tree and are never pushed to `main`;
   `changeset version` consumes them in the same job.
3. `changesets/action` creates or updates a single release pull request.
4. Changesets combines pending entries, updates `package.json`, creates or
   updates `CHANGELOG.md`, and removes the consumed changeset files.
5. A maintainer reviews and merges the release pull request.
6. The same workflow validates, builds, publishes the package to npm, creates a
   `@oneyoung/claude-devtools@<version>` git tag, and creates a GitHub Release.

Do not edit the package version or generated changelog entries manually. To
inspect exactly what npm will receive without publishing, run:

```bash
npm pack --dry-run
```

If publishing fails, fix the configuration and rerun the failed workflow. npm
does not allow overwriting a published version; never bump solely to hide a
failed release unless that version was actually published.
