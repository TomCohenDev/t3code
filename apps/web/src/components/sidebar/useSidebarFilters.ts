/**
 * Fork: sidebar filter state, out of `Sidebar.tsx`. The setting `sidebarFilters` holds owner,
 * machine, model and branch. The project filter is the per device scope in `uiStateStore`: "is"
 * is the scope of `Sidebar.tsx`, and "is_not" hides projects here. Drop it for an upstream one.
 */
import type { ProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarFilter as StoredSidebarFilter } from "@t3tools/contracts";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  resolveSidebarProjectScopeKeys,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useDelegatedUnderParent } from "../../state/entities";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  filterSidebarProjectGroups,
  isActiveSidebarFilter,
  type SidebarFilter,
  type SidebarFilterField,
  sidebarProjectGroupMemberKeys,
} from "../filters/sidebarFilters.logic";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

export type StoredSidebarFilterField = StoredSidebarFilter["field"];

/** The filter of one field, or null to remove it. */
export type SidebarFilterChange = Pick<SidebarFilter, "operator" | "values"> | null;

/**
 * The keys come from the unsorted groups, which keep their identity while threads stream, so the
 * keys and the rows that read them stay stable.
 */
export function useSidebarFilters<Group extends SidebarProjectSnapshot>(input: {
  readonly unsortedProjectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  /** The sorted groups, for the project section of the menu. */
  readonly projectGroups: ReadonlyArray<Group>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}) {
  const { unsortedProjectGroups, projectGroups, projectGroupingSettings } = input;
  // Counts cover the threads the sidebar lists: no archived threads and no subagents.
  const listedThreads = filterSidebarV2VisibleThreads(
    input.threads,
    null,
    useDelegatedUnderParent(),
  );
  const ownerFilterEnabled = useClientSettings((s) => s.pullRequestFilters);
  const savedFilters = useClientSettings((s) => s.sidebarFilters);
  const storedFilters = ownerFilterEnabled
    ? savedFilters
    : savedFilters.filter((filter) => filter.field !== "owner");
  const projectScopeOperator = useUiStateStore((s) => s.sidebarProjectScopeOperator);
  const projectScopeKeys = useUiStateStore((s) => s.sidebarProjectScopeKeys);
  const hiddenProjects: readonly SidebarFilter[] =
    projectScopeOperator === "is_not"
      ? [{ field: "project", operator: "is_not", values: projectScopeKeys }]
      : [];
  // Owner and hidden projects narrow the groups; the project scope ("is") narrows within them.
  const groupFilters = [...storedFilters, ...hiddenProjects];
  const unsortedVisibleGroups = filterSidebarProjectGroups(unsortedProjectGroups, groupFilters);
  const groupVisibleProjectKeys =
    unsortedVisibleGroups === unsortedProjectGroups
      ? null
      : sidebarProjectGroupMemberKeys(unsortedVisibleGroups);
  const visibleProjectGroups = filterSidebarProjectGroups(projectGroups, groupFilters);
  const threadFilters = storedFilters.filter(
    (filter) => filter.field !== "owner" && isActiveSidebarFilter(filter),
  );

  const setStoredFilter = (field: StoredSidebarFilterField, change: SidebarFilterChange) => {
    const rest = getClientSettings().sidebarFilters.filter((filter) => filter.field !== field);
    const next = change === null ? rest : [...rest, { field, ...change }];
    void updateClientSettings({ sidebarFilters: next });
    if (field !== "owner") return;
    // An owner change that hides the scoped project drops the scope too, so that the scope
    // cannot come back unseen when the owner filter goes.
    const { sidebarProjectScopeKeys, sidebarProjectScopeOperator, setSidebarProjectScopeKeys } =
      useUiStateStore.getState();
    if (sidebarProjectScopeOperator !== "is") return;
    const shownKeys = resolveSidebarProjectScopeKeys({
      groups: filterSidebarProjectGroups(
        unsortedProjectGroups,
        ownerFilterEnabled && change !== null ? [{ field, ...change }] : [],
      ),
      keys: sidebarProjectScopeKeys,
      settings: projectGroupingSettings,
      canClearMissingScope: true,
    });
    if (shownKeys.length !== sidebarProjectScopeKeys.length) setSidebarProjectScopeKeys(shownKeys);
  };

  // A selection made under one filter can hold threads the next one hides.
  const setFilter = (field: SidebarFilterField, change: SidebarFilterChange) => {
    useThreadSelectionStore.getState().clearSelection();
    if (field !== "project") return setStoredFilter(field, change);
    const { setSidebarProjectScopeKeys, setSidebarProjectScopeOperator } =
      useUiStateStore.getState();
    setSidebarProjectScopeKeys(change?.values ?? []);
    setSidebarProjectScopeOperator(change?.operator ?? "is");
  };
  const clearFilters = () => {
    useThreadSelectionStore.getState().clearSelection();
    // An owner filter that the off `pullRequestFilters` switch hides has no chip, so it stays.
    const kept = ownerFilterEnabled
      ? []
      : getClientSettings().sidebarFilters.filter((filter) => filter.field === "owner");
    void updateClientSettings({ sidebarFilters: kept });
    const { setSidebarProjectScopeKeys, setSidebarProjectScopeOperator } =
      useUiStateStore.getState();
    setSidebarProjectScopeKeys([]);
    setSidebarProjectScopeOperator("is");
  };

  return {
    ownerFilterEnabled,
    listedThreads,
    storedFilters,
    /** What the list applies on top of the project scope. */
    listFilter: {
      projectKeys: groupVisibleProjectKeys,
      filters: threadFilters,
      // Changes with each filter that changes the list, for state that resets with it.
      key: JSON.stringify(groupFilters.filter(isActiveSidebarFilter).concat(threadFilters)),
    },
    groupVisibleProjectKeys,
    visibleProjectGroups,
    setFilter,
    clearFilters,
  };
}
