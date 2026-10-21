#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - plain Node, so the daily release task runs it without `vp i`.
// Fork: collects the data of the daily release. See docs/fork/operations.md "Daily release".
//
//   node scripts/fork-daily-release-data.ts [--since <ref>] [--full-changelog]
//
// It picks the newest complete nightly on fork main after the previous stable release, and
// prints JSON with the changes since that stable release, in three groups: fork changes,
// upstream changes and the integration of upstream into the fork. An agent writes the notes
// from it and promotes the nightly. Without a stable release, the range starts where the fork
// began, and the upstream group holds only the commits of the last upstream merge.
// With --full-changelog, it prints the "Full changelog" part of the notes as markdown instead.

import * as NodeChildProcess from "node:child_process";

import { classifyFirstParentCommit, escapeText } from "./fork-release-notes.ts";

const FORK_REPOSITORY = "Yarden-zamir/t3code";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
/** Fork Release uploads it last, so a release with it is complete. See forkReleases.ts. */
const COMPLETE_RELEASE_ASSET = "SHA256SUMS";

export interface GitCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly author: string;
  /** ISO 8601. */
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
}

/** A first-parent commit of fork main, with the commits that its merge brought in. */
export interface FirstParentChange {
  readonly commit: GitCommit;
  /** For a merge: the commits it brought that the range did not already hold. Else empty. */
  readonly brought: ReadonlyArray<GitCommit>;
  /** The author of a pull request branch head. Undefined for a direct commit. */
  readonly branchAuthor: string | undefined;
}

export type ChangeSource =
  | { readonly _tag: "PullRequest"; readonly number: number; readonly url: string }
  | { readonly _tag: "Commit"; readonly sha: string; readonly url: string };

export interface ForkChange {
  readonly source: ChangeSource;
  readonly title: string;
  readonly author: string;
  /** ISO 8601. The merge time of a pull request, the commit time of a commit. */
  readonly at: string;
}

export interface UpstreamChange {
  readonly sha: string;
  readonly url: string;
  readonly title: string;
  readonly author: string;
  /** Upstream squash merges end their subject with `(#123)`. */
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

export interface IntegrationChange extends ForkChange {
  readonly upstreamCommitCount: number;
  /** The fork commits of the merge: conflict resolutions and fixes. */
  readonly fixes: ReadonlyArray<{
    readonly sha: string;
    readonly url: string;
    readonly title: string;
  }>;
}

export interface DailyChanges {
  readonly fork: ReadonlyArray<ForkChange>;
  readonly upstream: ReadonlyArray<UpstreamChange>;
  readonly integration: ReadonlyArray<IntegrationChange>;
}

const commitUrl = (repository: string, sha: string) =>
  `https://github.com/${repository}/commit/${sha}`;

function upstreamPullRequest(subject: string): UpstreamChange["pullRequest"] {
  const trimmed = subject.trimEnd();
  if (!trimmed.endsWith(")")) return null;
  const start = trimmed.lastIndexOf("(#");
  if (start === -1) return null;
  const number = Number(trimmed.slice(start + 2, -1));
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, url: `https://github.com/${UPSTREAM_REPOSITORY}/pull/${number}` };
}

function toUpstreamChange(commit: GitCommit): UpstreamChange {
  return {
    sha: commit.sha,
    url: commitUrl(UPSTREAM_REPOSITORY, commit.sha),
    title: commit.subject,
    author: commit.author,
    pullRequest: upstreamPullRequest(commit.subject),
  };
}

function toForkCommit(commit: GitCommit): ForkChange {
  return {
    source: { _tag: "Commit", sha: commit.sha, url: commitUrl(FORK_REPOSITORY, commit.sha) },
    title: commit.subject,
    author: commit.author,
    at: commit.committedAt,
  };
}

const isMerge = (commit: GitCommit) => commit.parents.length > 1;

/**
 * Sorts the first-parent commits of a range, oldest first, into the three groups. A commit that
 * brings upstream commits is integration work, and its own fork commits are its fixes. With
 * `onlyLastUpstreamMerge`, the upstream group holds only the commits of the newest such merge.
 */
export function groupDailyChanges(
  changes: ReadonlyArray<FirstParentChange>,
  isUpstream: (sha: string) => boolean,
  onlyLastUpstreamMerge: boolean,
): DailyChanges {
  const fork: ForkChange[] = [];
  const integration: IntegrationChange[] = [];
  const upstreamByMerge: UpstreamChange[][] = [];

  for (const { commit, brought, branchAuthor } of changes) {
    const kind = classifyFirstParentCommit(commit);
    const upstream = brought.filter((candidate) => isUpstream(candidate.sha));
    const upstreamChanges = upstream
      .filter((candidate) => !isMerge(candidate))
      .map(toUpstreamChange);
    const forkSide = brought.filter(
      (candidate) => !isUpstream(candidate.sha) && !isMerge(candidate),
    );
    const change: ForkChange =
      kind._tag === "PullRequest"
        ? {
            source: {
              _tag: "PullRequest",
              number: kind.number,
              url: `https://github.com/${FORK_REPOSITORY}/pull/${kind.number}`,
            },
            title: kind.title,
            author: branchAuthor ?? commit.author,
            at: commit.committedAt,
          }
        : toForkCommit(commit);

    if (upstream.length > 0) {
      integration.push({
        ...change,
        upstreamCommitCount: upstreamChanges.length,
        fixes: forkSide.map((fix) => ({
          sha: fix.sha,
          url: commitUrl(FORK_REPOSITORY, fix.sha),
          title: fix.subject,
        })),
      });
      upstreamByMerge.push(upstreamChanges);
    } else if (kind._tag === "PullRequest" || !isMerge(commit)) {
      fork.push(change);
    } else {
      // A direct merge of fork branches, from before the fork used pull requests.
      fork.push(...forkSide.map(toForkCommit));
    }
  }

  return {
    fork,
    upstream: onlyLastUpstreamMerge ? (upstreamByMerge.at(-1) ?? []) : upstreamByMerge.flat(),
    integration,
  };
}

function sourceLink(source: ChangeSource): string {
  return source._tag === "PullRequest"
    ? `[#${source.number}](${source.url})`
    : `[${source.sha.slice(0, 7)}](${source.url})`;
}

/** Without the `(#123)` suffix: in a fork release, GitHub would link it to a fork pull request. */
function upstreamTitle(change: UpstreamChange): string {
  if (change.pullRequest === null) return change.title;
  return change.title.slice(0, change.title.lastIndexOf("(#")).trimEnd();
}

/**
 * The full lists of the notes, newest first. The heading "Full changelog" also ends what the
 * desktop update popover reads (apps/desktop/src/updates/releaseNotes.ts), so it shows the
 * highlights above it.
 */
export function renderFullChangelog(changes: DailyChanges): string {
  const fork = changes.fork
    .toReversed()
    .map(
      (change) => `- ${sourceLink(change.source)} ${escapeText(change.title)} (${change.author})`,
    );
  const upstream = changes.upstream.toReversed().map((change) => {
    const link =
      change.pullRequest === null
        ? `[${change.sha.slice(0, 7)}](${change.url})`
        : `[upstream #${change.pullRequest.number}](${change.pullRequest.url})`;
    return `- ${link} ${escapeText(upstreamTitle(change))} (${change.author})`;
  });
  const integration = changes.integration
    .toReversed()
    .flatMap((change) => [
      `- ${sourceLink(change.source)} ${escapeText(change.title)}: ${change.upstreamCommitCount} upstream ${change.upstreamCommitCount === 1 ? "commit" : "commits"}, ${change.fixes.length} fork ${change.fixes.length === 1 ? "fix" : "fixes"}`,
      ...change.fixes.map(
        (fix) => `  - [${fix.sha.slice(0, 7)}](${fix.url}) ${escapeText(fix.title)}`,
      ),
    ]);
  const section = (title: string, lines: ReadonlyArray<string>) =>
    [
      `### ${title} (${lines.filter((line) => line.startsWith("- ")).length})`,
      "",
      ...(lines.length > 0 ? lines : ["- None."]),
    ].join("\n");
  return `${[
    "## Full changelog",
    section("Fork changes and additions", fork),
    section("Upstream changes and additions", upstream),
    section("Integration of upstream and fork", integration),
  ].join("\n\n")}\n`;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

function run(command: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

const git = (args: ReadonlyArray<string>) => run("git", args);

function readCommits(args: ReadonlyArray<string>): GitCommit[] {
  return git([
    "log",
    `--format=%H${FIELD}%P${FIELD}%an${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`,
    ...args,
  ])
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, parents, author, committedAt, subject, body] = record.trimStart().split(FIELD);
      if (
        sha === undefined ||
        parents === undefined ||
        author === undefined ||
        committedAt === undefined
      ) {
        throw new Error(`Cannot read the git log record: ${record}`);
      }
      return {
        sha,
        parents: parents.split(" ").filter((parent) => parent !== ""),
        author,
        committedAt,
        subject: subject ?? "",
        body: body ?? "",
      };
    });
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = NodeChildProcess.spawnSync("git", [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${result.stderr}`,
  );
}

/** Fetches a branch into FETCH_HEAD and returns its commit. */
function fetchBranch(remote: string, branch: string, tags: boolean): string {
  git(["fetch", "--quiet", tags ? "--tags" : "--no-tags", remote, branch]);
  return git(["rev-parse", "FETCH_HEAD"]).trim();
}

interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<{ readonly name: string }>;
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (typeof value !== "object" || value === null) return false;
  const release = value as Record<string, unknown>;
  return (
    typeof release["tag_name"] === "string" &&
    typeof release["html_url"] === "string" &&
    typeof release["draft"] === "boolean" &&
    typeof release["prerelease"] === "boolean" &&
    Array.isArray(release["assets"])
  );
}

/** Newest created first, like the GitHub API. */
function readReleases(): GitHubRelease[] {
  const releases: unknown = JSON.parse(
    run("gh", ["api", `repos/${FORK_REPOSITORY}/releases?per_page=100`]),
  );
  if (!Array.isArray(releases) || !releases.every(isGitHubRelease)) {
    throw new Error("The GitHub releases response has an unexpected shape.");
  }
  return releases.filter((release) => !release.draft);
}

const tagCommit = (tag: string) => git(["rev-parse", "--verify", `${tag}^{commit}`]).trim();

/** The parent of the oldest first-parent commit of fork main that upstream does not have. */
function findForkBase(main: string, upstream: string): string {
  const forkOnly = git(["rev-list", "--first-parent", main, "--not", upstream]).trim().split("\n");
  const oldest = forkOnly.at(-1);
  if (oldest === undefined || oldest === "")
    throw new Error("Fork main has no commits that upstream lacks.");
  return git(["rev-parse", `${oldest}^`]).trim();
}

function readFlag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function main(args: ReadonlyArray<string>): void {
  const mainHead = fetchBranch(`https://github.com/${FORK_REPOSITORY}.git`, "main", true);
  const upstreamHead = fetchBranch(`https://github.com/${UPSTREAM_REPOSITORY}.git`, "main", false);
  const releases = readReleases();

  const previousStable = releases.find((release) => !release.prerelease);
  const sinceFlag = readFlag(args, "--since");
  const since = sinceFlag
    ? {
        tag: null,
        ref: sinceFlag,
        sha: git(["rev-parse", "--verify", `${sinceFlag}^{commit}`]).trim(),
      }
    : previousStable
      ? {
          tag: previousStable.tag_name,
          ref: previousStable.tag_name,
          sha: tagCommit(previousStable.tag_name),
        }
      : { tag: null, ref: "fork base", sha: findForkBase(mainHead, upstreamHead) };
  const firstRelease = previousStable === undefined;

  // The newest nightly first. Its build may still run: then it lacks SHA256SUMS, and an older one wins.
  const nightly = releases
    .filter((release) => release.prerelease && release.tag_name.includes("-nightly."))
    .filter((release) => release.assets.some((asset) => asset.name === COMPLETE_RELEASE_ASSET))
    .map((release) => ({ release, sha: tagCommit(release.tag_name) }))
    .find(({ sha }) => isAncestor(sha, mainHead));

  if (nightly === undefined || isAncestor(nightly.sha, since.sha)) {
    process.stdout.write(
      `${JSON.stringify({ skip: `No complete nightly on main after ${since.tag ?? since.ref}.` }, null, 2)}\n`,
    );
    return;
  }

  const upstreamShas = new Set(
    git(["rev-list", upstreamHead, "--not", since.sha]).trim().split("\n"),
  );
  const changes = readCommits(["--first-parent", "--reverse", `${since.sha}..${nightly.sha}`]).map(
    (commit): FirstParentChange => {
      const [firstParent, secondParent] = commit.parents;
      if (firstParent === undefined || secondParent === undefined) {
        return { commit, brought: [], branchAuthor: undefined };
      }
      return {
        commit,
        brought: readCommits([commit.sha, "--not", firstParent, since.sha]).filter(
          (candidate) => candidate.sha !== commit.sha,
        ),
        branchAuthor: readCommits(["-1", secondParent])[0]?.author,
      };
    },
  );

  const grouped = groupDailyChanges(
    changes,
    (sha) => upstreamShas.has(sha),
    firstRelease && sinceFlag === undefined,
  );
  if (args.includes("--full-changelog")) {
    process.stdout.write(renderFullChangelog(grouped));
    return;
  }
  const data = {
    release: {
      tag: nightly.release.tag_name,
      url: nightly.release.html_url,
      sha: nightly.sha,
      isMainHead: nightly.sha === mainHead,
      mainHead,
    },
    since: { tag: since.tag, ref: since.ref, sha: since.sha },
    firstRelease,
    ...grouped,
  };
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message.trimEnd() : String(error)}\n`);
    process.exitCode = 1;
  }
}
