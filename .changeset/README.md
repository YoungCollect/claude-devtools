# Changesets

Changesets are generated from commit subjects, so a
[Conventional Commit](https://www.conventionalcommits.org/) is normally all a
user-visible change needs. The release workflow runs the generator on `main`;
locally you can preview the result:

```bash
pnpm changeset:auto --dry-run
```

`feat:` bumps minor, `fix:`/`perf:`/`refactor:`/`revert:` bump patch, a `!`
marker or a `BREAKING CHANGE:` body bumps major, and `docs:`/`chore:`/`test:`/
`ci:`/`build:`/`style:` are skipped.

Write a changeset by hand when the changelog needs wording the commit subject
cannot carry:

```bash
pnpm changeset
```

Hand-written and generated changesets are combined by the automated release pull
request. Do not edit the version in `package.json` or `CHANGELOG.md` by hand.
Generated files are named `auto-<short-sha>.md`.

See [`docs/releasing.md`](../docs/releasing.md) for the full lifecycle.
