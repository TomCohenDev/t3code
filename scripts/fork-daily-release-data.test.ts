import { assert, it } from "@effect/vitest";

import {
  type FirstParentChange,
  type GitCommit,
  groupDailyChanges,
} from "./fork-daily-release-data.ts";

const commit = (
  sha: string,
  subject: string,
  parents: ReadonlyArray<string> = ["p"],
  body = "",
): GitCommit => ({
  sha,
  parents,
  author: `author of ${sha}`,
  committedAt: "2026-10-20T10:00:00Z",
  subject,
  body,
});

const upstreamShas = new Set(["u1", "u2", "u3", "um"]);
const isUpstream = (sha: string) => upstreamShas.has(sha);

const changes: ReadonlyArray<FirstParentChange> = [
  {
    commit: commit(
      "m1",
      "Merge pull request #10 from Yarden-zamir/feat/a",
      ["p", "b1"],
      "feat: a\n",
    ),
    brought: [commit("b1", "feat: a")],
    branchAuthor: "Yarden",
  },
  {
    commit: commit("s1", "chore(sync): merge pingdotgg/t3code main", ["m1", "u1"]),
    brought: [commit("u1", "fix: one (#501)")],
    branchAuthor: "upstream author",
  },
  { commit: commit("d1", "docs(fork): direct"), brought: [], branchAuthor: undefined },
  {
    commit: commit(
      "m2",
      "Merge pull request #11 from Yarden-zamir/fork-sync/x",
      ["d1", "f1"],
      "chore(sync): merge upstream main\n",
    ),
    brought: [
      commit("f1", "fix(fork): keep a fork feature"),
      commit("fm", "Merge remote-tracking branch 'upstream/main'", ["d1", "um"]),
      commit("um", "Merge upstream branch", ["u2", "u3"]),
      commit("u3", "feat: three"),
      commit("u2", "feat: two (#502)"),
    ],
    branchAuthor: "Yarden",
  },
];

it("sorts pull requests, direct commits and upstream merges into the three groups", () => {
  const grouped = groupDailyChanges(changes, isUpstream, false);
  assert.deepStrictEqual(
    grouped.fork.map((change) => [change.source._tag, change.title, change.author]),
    [
      ["PullRequest", "feat: a", "Yarden"],
      ["Commit", "docs(fork): direct", "author of d1"],
    ],
  );
  assert.deepStrictEqual(
    grouped.integration.map((change) => ({
      title: change.title,
      upstreamCommitCount: change.upstreamCommitCount,
      fixes: change.fixes.map((fix) => fix.sha),
    })),
    [
      { title: "chore(sync): merge pingdotgg/t3code main", upstreamCommitCount: 1, fixes: [] },
      { title: "chore(sync): merge upstream main", upstreamCommitCount: 2, fixes: ["f1"] },
    ],
  );
  // Upstream merge commits are not changes. A squash merge links its pull request.
  assert.deepStrictEqual(
    grouped.upstream.map((change) => [change.sha, change.pullRequest?.number ?? null]),
    [
      ["u1", 501],
      ["u3", null],
      ["u2", 502],
    ],
  );
});

it("keeps only the last upstream merge for the first release", () => {
  const grouped = groupDailyChanges(changes, isUpstream, true);
  assert.deepStrictEqual(
    grouped.upstream.map((change) => change.sha),
    ["u3", "u2"],
  );
  assert.strictEqual(grouped.integration.length, 2);
});

it("lists the fork commits of a direct merge of fork branches", () => {
  const grouped = groupDailyChanges(
    [
      {
        commit: commit("dm", "Merge remote-tracking branch 'origin/main' into feat/b", ["p", "f2"]),
        brought: [commit("f2", "feat(fork): b")],
        branchAuthor: "Yarden",
      },
    ],
    isUpstream,
    false,
  );
  assert.deepStrictEqual(
    grouped.fork.map((change) => change.title),
    ["feat(fork): b"],
  );
  assert.strictEqual(grouped.integration.length, 0);
});
