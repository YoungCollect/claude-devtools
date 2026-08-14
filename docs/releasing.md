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

For a user-visible change, create a changeset before opening the pull request:

```bash
pnpm changeset
```

Select the SemVer bump:

- `patch`: backwards-compatible fix or small behavior improvement
- `minor`: backwards-compatible feature
- `major`: breaking CLI, configuration, storage, or behavior change

Write the summary for package users; it becomes part of `CHANGELOG.md`. Pure
tests, documentation, chores, and internal refactors can omit a changeset.

## Automated release lifecycle

1. Changes containing changeset files merge into `main`.
2. `release.yml` creates or updates a single release pull request.
3. Changesets combines pending entries, updates `package.json`, creates or
   updates `CHANGELOG.md`, and removes the consumed changeset files.
4. A maintainer reviews and merges the release pull request.
5. The same workflow validates, builds, publishes the package to npm, creates a
   `@oneyoung/claude-devtools@<version>` git tag, and creates a GitHub Release.

Do not edit the package version or generated changelog entries manually. To
inspect exactly what npm will receive without publishing, run:

```bash
npm pack --dry-run
```

If publishing fails, fix the configuration and rerun the failed workflow. npm
does not allow overwriting a published version; never bump solely to hide a
failed release unless that version was actually published.
