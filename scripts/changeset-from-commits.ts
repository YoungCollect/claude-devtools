/**
 * Generate changeset files from conventional commits.
 *
 * Changesets still owns version resolution and CHANGELOG assembly; this script
 * only replaces the manual `pnpm changeset` prompt by deriving one changeset
 * per releasable commit since the last release tag.
 *
 * The release workflow runs this on every push to `main`, so the generated
 * `.changeset/auto-<sha>.md` files are gitignored scratch output; `--dry-run` is
 * the normal local invocation.
 *
 * Usage:
 *   pnpm changeset:auto --dry-run    # print what would be written
 *   pnpm changeset:auto              # write .changeset/auto-<sha>.md files
 *   pnpm changeset:auto --all        # also include docs/chore/test/... commits
 *   CHANGESET_BASE=v0.1.0 pnpm changeset:auto
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Bump = "major" | "minor" | "patch";

/** Conventional-commit type -> release bump. Types absent here are skipped. */
const BUMP_BY_TYPE: Record<string, Bump> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  refactor: "patch",
  revert: "patch",
};

/** Types that only land in the changelog with `--all`. */
const NON_RELEASE_BUMP: Bump = "patch";
const NON_RELEASE_TYPES = new Set([
  "docs",
  "chore",
  "test",
  "ci",
  "build",
  "style",
]);

/**
 * Subjects produced by the release automation itself. Keep in sync with the
 * `commit:` input of `changesets/action` in `.github/workflows/release.yml`.
 */
const RELEASE_COMMIT = /^chore: release\b/;
const RELEASE_COMMIT_GREP = "^chore: release";

const COMMIT_PATTERN = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<subject>.+)$/;
const BREAKING_BODY = /^BREAKING[ -]CHANGE:/m;

// ASCII record/unit separators: safe against newlines and quotes inside commit bodies.
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const changesetDir = join(repoRoot, ".changeset");

interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
}

interface Entry {
  commit: Commit;
  bump: Bump;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Same as `git`, but returns null instead of throwing, and null for empty output. */
function tryGit(...args: string[]): string | null {
  try {
    return git(...args) || null;
  } catch {
    return null;
  }
}

/**
 * The commit the last release was cut from.
 *
 * The release commit — not the `v*` tag — is the baseline: tags are only
 * created once `changeset publish` runs, so a tag baseline would re-emit
 * changesets for commits that the just-merged release PR already consumed,
 * and the workflow would open a new release PR instead of publishing.
 */
function resolveBase(): string {
  const override = process.env["CHANGESET_BASE"];
  if (override) return override;

  const releaseCommit = tryGit("rev-list", "-1", `--grep=${RELEASE_COMMIT_GREP}`, "HEAD");
  if (releaseCommit) return releaseCommit;

  const lastTag = tryGit("describe", "--tags", "--abbrev=0", "--match", "v*");
  if (lastTag) return lastTag;

  return git("rev-list", "--max-parents=0", "HEAD");
}

function readCommits(base: string): Commit[] {
  const raw = git(
    "log",
    "--no-merges",
    "--reverse",
    `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    `${base}..HEAD`,
  );
  if (!raw) return [];

  return raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(FIELD_SEPARATOR);
      return { sha, shortSha: sha.slice(0, 7), subject, body };
    });
}

function classify(commit: Commit, includeAll: boolean): Bump | null {
  if (RELEASE_COMMIT.test(commit.subject)) return null;

  const match = COMMIT_PATTERN.exec(commit.subject);
  if (!match?.groups) return includeAll ? NON_RELEASE_BUMP : null;

  const { type = "", breaking } = match.groups;
  if (breaking || BREAKING_BODY.test(commit.body)) return "major";

  const bump = BUMP_BY_TYPE[type.toLowerCase()];
  if (bump) return bump;
  if (includeAll && NON_RELEASE_TYPES.has(type.toLowerCase())) {
    return NON_RELEASE_BUMP;
  }
  return null;
}

function packageName(): string {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { name?: unknown };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("package.json is missing a name field");
  }
  return manifest.name;
}

function render(name: string, entry: Entry): string {
  const summary = entry.commit.subject.trim();
  return `---\n${JSON.stringify(name)}: ${entry.bump}\n---\n\n${summary} (${entry.commit.shortSha})\n`;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const includeAll = args.has("--all");

  const base = resolveBase();
  const commits = readCommits(base);
  const name = packageName();

  const entries: Entry[] = [];
  for (const commit of commits) {
    const bump = classify(commit, includeAll);
    if (bump) entries.push({ commit, bump });
  }

  console.log(`Base: ${base} — ${commits.length} commit(s), ${entries.length} releasable.`);

  if (entries.length === 0) {
    console.log("No changeset written.");
    return;
  }

  if (!dryRun) mkdirSync(changesetDir, { recursive: true });

  let written = 0;
  for (const entry of entries) {
    const file = join(changesetDir, `auto-${entry.commit.shortSha}.md`);
    const exists = existsSync(file);
    const note = exists ? " (changeset already exists)" : "";

    console.log(
      `  ${entry.bump.padEnd(5)} ${entry.commit.shortSha} ${entry.commit.subject}${note}`,
    );

    if (dryRun || exists) continue;
    writeFileSync(file, render(name, entry), { encoding: "utf8", mode: 0o644 });
    written += 1;
  }

  console.log(dryRun ? "Dry run — nothing written." : `Wrote ${written} changeset file(s).`);
}

main();
