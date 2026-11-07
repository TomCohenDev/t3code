/**
 * Fork: the sidebar filter model. Owner and project filters compare the project group, so every
 * machine's checkout of a repository moves together. Machine, model and branch filters compare
 * the thread. Each filter shows only (`is`) or hides (`is_not`) the items with one of its values.
 * If upstream T3 Code ships sidebar filters, drop this fork version and use theirs.
 */
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  repositoryOwnerOf,
  type SidebarFilterField as StoredFilterField,
} from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import type { FilterOperator } from "./FilterChip";

export type SidebarFilterField = "project" | StoredFilterField;
type GroupField = Extract<SidebarFilterField, "project" | "owner">;
type ThreadField = Exclude<SidebarFilterField, GroupField>;

export interface SidebarFilter {
  readonly field: SidebarFilterField;
  readonly operator: FilterOperator;
  /** Empty values filter nothing. */
  readonly values: readonly string[];
}

/** The order of the fields in the menu and of the chips. */
export const SIDEBAR_FILTER_FIELDS = [
  "project",
  "machine",
  "model",
  "branch",
  "owner",
] as const satisfies ReadonlyArray<SidebarFilterField>;

export const SIDEBAR_FILTER_FIELD_LABELS = {
  project: "Project",
  machine: "Machine",
  model: "Model",
  branch: "Branch",
  owner: "Owner",
} as const satisfies Record<SidebarFilterField, string>;

/** The value for "none": a project without a repository owner, or a thread without a branch. */
export const NO_FILTER_VALUE = "";

export type SidebarFilterGroup = Pick<
  SidebarProjectSnapshot,
  "projectKey" | "repositoryIdentity" | "memberProjectRefs" | "pinned" | "archived"
>;
export type SidebarFilterThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "projectId" | "branch" | "modelSelection" | "runtime"
>;

export const isActiveSidebarFilter = (filter: SidebarFilter) => filter.values.length > 0;

const isGroupField = (field: SidebarFilterField): field is GroupField =>
  field === "project" || field === "owner";

type FieldFilter<F extends SidebarFilterField> = SidebarFilter & { readonly field: F };
const isActiveGroupFilter = (filter: SidebarFilter): filter is FieldFilter<GroupField> =>
  isGroupField(filter.field) && isActiveSidebarFilter(filter);
const isActiveThreadFilter = (filter: SidebarFilter): filter is FieldFilter<ThreadField> =>
  !isGroupField(filter.field) && isActiveSidebarFilter(filter);

const projectKeyOf = (ref: { readonly environmentId: string; readonly projectId: string }) =>
  `${ref.environmentId}:${ref.projectId}`;

/** A provider instance id has no colon, so the first colon ends it. */
export function sidebarModelFilterValue(instanceId: string, model: string): string {
  return `${instanceId}:${model}`;
}

export function parseSidebarModelFilterValue(value: string): {
  readonly instanceId: string;
  readonly model: string;
} {
  const colon = value.indexOf(":");
  if (colon <= 0) throw new Error(`Not a sidebar model filter value: ${value}`);
  return { instanceId: value.slice(0, colon), model: value.slice(colon + 1) };
}

export function sidebarThreadFilterValue(thread: SidebarFilterThread, field: ThreadField): string {
  switch (field) {
    case "machine":
      return thread.environmentId;
    case "model":
      return sidebarModelFilterValue(
        thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
        thread.modelSelection.model,
      );
    case "branch":
      return thread.branch ?? NO_FILTER_VALUE;
  }
}

function sidebarGroupFilterValue(
  group: Pick<SidebarFilterGroup, "projectKey" | "repositoryIdentity">,
  field: GroupField,
): string {
  return field === "project"
    ? group.projectKey
    : (repositoryOwnerOf(group.repositoryIdentity, "grouping") ?? NO_FILTER_VALUE);
}

const passes = (filter: SidebarFilter, value: string) =>
  filter.values.includes(value) === (filter.operator === "is");

/** The groups that the owner and project filters show. Without such a filter, the same array. */
export function filterSidebarProjectGroups<G extends SidebarFilterGroup>(
  groups: readonly G[],
  filters: readonly SidebarFilter[],
): readonly G[] {
  const active = filters.filter(isActiveGroupFilter);
  if (active.length === 0) return groups;
  return groups.filter((group) =>
    active.every((filter) => passes(filter, sidebarGroupFilterValue(group, filter.field))),
  );
}

/** The `environmentId:projectId` keys of the groups' member projects, the key that threads match. */
export function sidebarProjectGroupMemberKeys(
  groups: ReadonlyArray<Pick<SidebarFilterGroup, "memberProjectRefs">>,
): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => group.memberProjectRefs.map(projectKeyOf)));
}

/**
 * The threads in `projectKeys` (null for every project) that the machine, model and branch
 * filters show. Without anything to filter, the same array.
 */
export function filterSidebarThreads<T extends SidebarFilterThread>(
  threads: readonly T[],
  projectKeys: ReadonlySet<string> | null,
  filters: readonly SidebarFilter[],
): readonly T[] {
  const active = filters.filter(isActiveThreadFilter);
  if (projectKeys === null && active.length === 0) return threads;
  return threads.filter(
    (thread) =>
      (projectKeys === null || projectKeys.has(projectKeyOf(thread))) &&
      active.every((filter) => passes(filter, sidebarThreadFilterValue(thread, filter.field))),
  );
}

/**
 * Applies every filter: owner and project to the groups, the rest to the threads. A thread shows
 * only when its group shows. `projectKeys` is null when no group filter is active.
 */
export function applySidebarFilters<
  G extends SidebarFilterGroup,
  T extends SidebarFilterThread,
>(input: {
  readonly filters: readonly SidebarFilter[];
  readonly groups: readonly G[];
  readonly threads: readonly T[];
}): {
  readonly groups: readonly G[];
  readonly projectKeys: ReadonlySet<string> | null;
  readonly threads: readonly T[];
} {
  const groups = filterSidebarProjectGroups(input.groups, input.filters);
  const projectKeys = groups === input.groups ? null : sidebarProjectGroupMemberKeys(groups);
  return {
    groups,
    projectKeys,
    threads: filterSidebarThreads(input.threads, projectKeys, input.filters),
  };
}

type NeedingUserThread = SidebarFilterThread & Parameters<typeof resolveSidebarThreadStatus>[0];

/**
 * For each active filter, the threads it hides that wait for an approval or an answer. The chip
 * of the filter shows this count, so that no filter hides a thread that needs the user without
 * a trace. A thread that two filters hide counts for both.
 */
export function countHiddenThreadsNeedingUser(input: {
  readonly filters: readonly SidebarFilter[];
  readonly groups: readonly SidebarFilterGroup[];
  readonly threads: readonly NeedingUserThread[];
}): ReadonlyMap<SidebarFilterField, number> {
  const needingUser = input.threads.filter((thread) => {
    const status = resolveSidebarThreadStatus(thread);
    return status === "approval" || status === "input";
  });
  const counts = new Map<SidebarFilterField, number>();
  if (needingUser.length === 0) return counts;
  for (const filter of input.filters) {
    if (!isActiveSidebarFilter(filter)) continue;
    const shown = applySidebarFilters({
      filters: [filter],
      groups: input.groups,
      threads: needingUser,
    }).threads.length;
    if (shown < needingUser.length) counts.set(filter.field, needingUser.length - shown);
  }
  return counts;
}

export interface SidebarFilterOption {
  readonly value: string;
  readonly label: string;
  readonly threadCount: number;
}

/**
 * The menu entries of one field, each with the threads that it would show under the other
 * filters. A value without threads is left out, except a project, so the user can scope to it and
 * start a thread, and a selected value, so the user can clear it. Projects keep the group order,
 * pinned first and without archived ones. Other values sort by label, and "none" comes last.
 */
export function buildSidebarFilterOptions(input: {
  readonly field: SidebarFilterField;
  readonly filters: readonly SidebarFilter[];
  readonly groups: readonly SidebarFilterGroup[];
  readonly threads: readonly SidebarFilterThread[];
  readonly label: (value: string) => string;
}): SidebarFilterOption[] {
  const { field, label } = input;
  const others = input.filters.filter((filter) => filter.field !== field);
  const shown = applySidebarFilters({
    filters: others,
    groups: input.groups,
    threads: input.threads,
  });
  const groupByProjectKey = new Map<string, SidebarFilterGroup>();
  for (const group of input.groups) {
    for (const ref of group.memberProjectRefs) groupByProjectKey.set(projectKeyOf(ref), group);
  }
  const counts = new Map<string, number>();
  for (const thread of shown.threads) {
    let value: string;
    if (isGroupField(field)) {
      const group = groupByProjectKey.get(projectKeyOf(thread));
      if (group === undefined) continue;
      value = sidebarGroupFilterValue(group, field);
    } else {
      value = sidebarThreadFilterValue(thread, field);
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const selected = input.filters.find((filter) => filter.field === field)?.values ?? [];
  const option = (value: string): SidebarFilterOption => ({
    value,
    label: label(value),
    threadCount: counts.get(value) ?? 0,
  });
  if (field === "project") {
    const values = pickableProjectGroups(shown.groups).map((group) => group.projectKey);
    const missing = selected.filter((value) => !values.includes(value));
    return [...missing, ...values].map(option);
  }
  const values = new Set([...counts.keys(), ...selected]);
  return [...values]
    .map(option)
    .toSorted((left, right) =>
      left.value === NO_FILTER_VALUE
        ? 1
        : right.value === NO_FILTER_VALUE
          ? -1
          : left.label.localeCompare(right.label),
    );
}

/**
 * The values after a pick in the menu. A plain pick shows only that value, and a second plain
 * pick of the only value clears it. A toggle pick (Shift) adds or removes one value.
 */
export function pickSidebarFilterValue(
  selected: readonly string[],
  value: string,
  toggle: boolean,
): string[] {
  if (toggle) {
    return selected.includes(value)
      ? selected.filter((candidate) => candidate !== value)
      : [...selected, value];
  }
  return selected.length === 1 && selected[0] === value ? [] : [value];
}

/** Whether every active filter of `field` shows `value`. */
export function sidebarFiltersShow(
  filters: readonly SidebarFilter[],
  field: SidebarFilterField,
  value: string,
): boolean {
  return filters.every(
    (filter) => filter.field !== field || !isActiveSidebarFilter(filter) || passes(filter, value),
  );
}
