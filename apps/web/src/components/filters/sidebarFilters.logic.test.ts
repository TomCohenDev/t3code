import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { Project } from "../../types";
import {
  applySidebarFilters,
  buildSidebarFilterOptions,
  countHiddenThreadsNeedingUser,
  filterSidebarThreads,
  NO_FILTER_VALUE,
  parseSidebarModelFilterValue,
  pickSidebarFilterValue,
  type SidebarFilter,
  sidebarModelFilterValue,
} from "./sidebarFilters.logic";

const mac = EnvironmentId.make("environment-mac");
const vps = EnvironmentId.make("environment-vps");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");

function identity(canonicalKey: string, originKey?: string): RepositoryIdentity {
  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
    ...(originKey === undefined ? {} : { origin: { canonicalKey: originKey } }),
  };
}

function project(
  environmentId: EnvironmentId,
  id: string,
  repositoryIdentity: RepositoryIdentity | null,
): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: { instanceId: codex, model: "gpt-5.4" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    scripts: [],
  };
}

// One work repository checked out on two machines, a personal repository, a fork of an
// upstream repository, and a folder without a remote.
const groups = buildSidebarProjectSnapshots({
  projects: [
    project(mac, "work-mac", identity("github.com/qlik-trial/app")),
    project(vps, "work-vps", identity("github.com/qlik-trial/app")),
    project(mac, "dotfiles", identity("github.com/yarden-zamir/dotfiles")),
    project(
      mac,
      "t3code",
      identity("github.com/pingdotgg/t3code", "github.com/yarden-zamir/t3code"),
    ),
    project(mac, "notes", null),
  ],
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: mac,
  resolveEnvironmentLabel: () => null,
});
const groupKeyOf = (projectId: string) =>
  groups.find((group) =>
    group.memberProjectRefs.some((ref) => ref.projectId === ProjectId.make(projectId)),
  )!.projectKey;

const thread = (
  id: string,
  environmentId: EnvironmentId,
  projectId: string,
  overrides: ThreadFixtureOverrides = {},
) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(projectId),
    ...overrides,
  });

const threads = [
  thread("work-mac", mac, "work-mac", { branch: "main" }),
  thread("work-vps", vps, "work-vps", {
    branch: "feature",
    modelSelection: { instanceId: claude, model: "opus" },
  }),
  thread("dotfiles", mac, "dotfiles", { branch: "main" }),
  thread("t3code", mac, "t3code", { branch: "fork" }),
  thread("notes", mac, "notes"),
];

const shownIds = (filters: readonly SidebarFilter[]) =>
  applySidebarFilters({ filters, groups, threads }).threads.map((shown) => shown.id);

describe("applySidebarFilters", () => {
  it.each<{ name: string; filter: SidebarFilter; shown: string[] }>([
    {
      name: "owner is: every machine's checkout of the owner's repository",
      filter: { field: "owner", operator: "is", values: ["qlik-trial"] },
      shown: ["work-mac", "work-vps"],
    },
    {
      name: "owner is not: a fork counts under its own owner, none matches no owner",
      filter: { field: "owner", operator: "is_not", values: ["yarden-zamir", NO_FILTER_VALUE] },
      shown: ["work-mac", "work-vps"],
    },
    {
      name: "project is: the whole group across machines",
      filter: { field: "project", operator: "is", values: [groupKeyOf("work-mac")] },
      shown: ["work-mac", "work-vps"],
    },
    {
      name: "project is not",
      filter: { field: "project", operator: "is_not", values: [groupKeyOf("work-mac")] },
      shown: ["dotfiles", "t3code", "notes"],
    },
    {
      name: "machine is",
      filter: { field: "machine", operator: "is", values: [vps] },
      shown: ["work-vps"],
    },
    {
      name: "machine is not",
      filter: { field: "machine", operator: "is_not", values: [vps] },
      shown: ["work-mac", "dotfiles", "t3code", "notes"],
    },
    {
      name: "model is: provider instance and model",
      filter: { field: "model", operator: "is", values: [sidebarModelFilterValue(claude, "opus")] },
      shown: ["work-vps"],
    },
    {
      name: "model is not",
      filter: {
        field: "model",
        operator: "is_not",
        values: [sidebarModelFilterValue(codex, "gpt-5.4")],
      },
      shown: ["work-vps"],
    },
    {
      name: "branch is",
      filter: { field: "branch", operator: "is", values: ["main"] },
      shown: ["work-mac", "dotfiles"],
    },
    {
      name: "branch is not: none matches a thread without a branch",
      filter: { field: "branch", operator: "is_not", values: ["main", NO_FILTER_VALUE] },
      shown: ["work-vps", "t3code"],
    },
  ])("$name", ({ filter, shown }) => {
    expect(shownIds([filter])).toEqual(shown);
  });

  it("applies every filter together", () => {
    expect(
      shownIds([
        { field: "owner", operator: "is", values: ["qlik-trial"] },
        { field: "machine", operator: "is", values: [mac] },
      ]),
    ).toEqual(["work-mac"]);
  });

  it("filters nothing with empty values, and keeps the same arrays", () => {
    const result = applySidebarFilters({
      filters: [
        { field: "owner", operator: "is", values: [] },
        { field: "branch", operator: "is_not", values: [] },
      ],
      groups,
      threads,
    });
    expect(result.groups).toBe(groups);
    expect(result.projectKeys).toBeNull();
    expect(result.threads).toBe(threads);
    expect(filterSidebarThreads(threads, null, [])).toBe(threads);
  });
});

describe("parseSidebarModelFilterValue", () => {
  it("splits at the first colon, so a model may hold one", () => {
    expect(parseSidebarModelFilterValue(sidebarModelFilterValue(codex, "a:b"))).toEqual({
      instanceId: codex,
      model: "a:b",
    });
    expect(() => parseSidebarModelFilterValue("no-colon")).toThrow();
  });
});

describe("countHiddenThreadsNeedingUser", () => {
  it("counts per filter the hidden threads that wait for an approval or an answer", () => {
    const waiting = [
      ...threads,
      thread("approval", vps, "work-vps", { hasPendingApprovals: true }),
      thread("question", mac, "dotfiles", { hasPendingUserInput: true }),
    ];
    const counts = countHiddenThreadsNeedingUser({
      filters: [
        { field: "machine", operator: "is", values: [mac] },
        { field: "owner", operator: "is", values: ["yarden-zamir"] },
        { field: "branch", operator: "is", values: [] },
      ],
      groups,
      threads: waiting,
    });
    expect(counts).toEqual(
      new Map([
        ["machine", 1],
        ["owner", 1],
      ]),
    );
  });
});

describe("buildSidebarFilterOptions", () => {
  const label = (value: string) => (value === NO_FILTER_VALUE ? "None" : value);

  it("counts each value under the other filters, sorts by label and puts none last", () => {
    expect(
      buildSidebarFilterOptions({
        field: "branch",
        filters: [{ field: "machine", operator: "is", values: [mac] }],
        groups,
        threads,
        label,
      }),
    ).toEqual([
      { value: "fork", label: "fork", threadCount: 1 },
      { value: "main", label: "main", threadCount: 2 },
      { value: NO_FILTER_VALUE, label: "None", threadCount: 1 },
    ]);
  });

  it("keeps a selected value without threads, so the user can clear it", () => {
    expect(
      buildSidebarFilterOptions({
        field: "owner",
        filters: [{ field: "owner", operator: "is", values: ["gone-org"] }],
        groups,
        threads: [],
        label,
      }),
    ).toEqual([{ value: "gone-org", label: "gone-org", threadCount: 0 }]);
  });

  it("offers every open project of the shown owners, also without threads", () => {
    const options = buildSidebarFilterOptions({
      field: "project",
      filters: [{ field: "owner", operator: "is", values: ["qlik-trial"] }],
      groups,
      threads: [],
      label,
    });
    expect(options).toEqual([
      { value: groupKeyOf("work-mac"), label: groupKeyOf("work-mac"), threadCount: 0 },
    ]);
  });
});

describe("pickSidebarFilterValue", () => {
  it.each([
    { selected: [], value: "a", toggle: false, next: ["a"] },
    { selected: ["a", "b"], value: "b", toggle: false, next: ["b"] },
    { selected: ["a"], value: "a", toggle: false, next: [] },
    { selected: ["a"], value: "b", toggle: true, next: ["a", "b"] },
    { selected: ["a", "b"], value: "a", toggle: true, next: ["b"] },
  ])("picks $value from $selected (toggle: $toggle)", ({ selected, value, toggle, next }) => {
    expect(pickSidebarFilterValue(selected, value, toggle)).toEqual(next);
  });
});
