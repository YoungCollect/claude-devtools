# Changesets

Every user-visible change should include a changeset:

```bash
pnpm changeset
```

Choose the SemVer impact and describe the change in language suitable for the
public changelog. Documentation, tests, and internal refactors that do not
change published behavior do not need one.

Changesets are consumed by the automated release pull request. Do not edit the
version in `package.json` or `CHANGELOG.md` by hand.
