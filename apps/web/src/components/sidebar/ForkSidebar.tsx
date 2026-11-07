/**
 * Fork parts of the sidebar thread list header (`Sidebar.tsx`): the Filter menu, the filter
 * chips and the sidebar tabs. The sidebar imports this module once and keeps one line per hook.
 */
import type { ComponentProps } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  buildSidebarFilterOptions,
  countHiddenThreadsNeedingUser,
  isActiveSidebarFilter,
  SIDEBAR_FILTER_FIELDS,
  type SidebarFilter,
} from "../filters/sidebarFilters.logic";
import type { SidebarFilterLabeler } from "./sidebarFilterLabels";
import {
  type SidebarFilterChangeHandler,
  SidebarFilterChips,
  SidebarFilterMenu,
  type SidebarFilterProjectRows,
  type SidebarFilterSection,
} from "./SidebarFilterMenu";
import { SidebarTabBar } from "./SidebarTabBar";
import type { useSidebarFilters } from "./useSidebarFilters";

export { makeSidebarFilterLabeler } from "./sidebarFilterLabels";
export { useSidebarFilters } from "./useSidebarFilters";
export { useSidebarTabs } from "./useSidebarTabs";

type FilterState = Pick<
  ReturnType<typeof useSidebarFilters>,
  "ownerFilterEnabled" | "listedThreads" | "storedFilters" | "clearFilters"
>;

/** What the menu and the chips read: the stored filters and the project filter. */
export interface SidebarFilterView {
  readonly state: FilterState;
  /** The project scope, or the hidden projects. */
  readonly project: SidebarFilter;
  /** The sorted project groups. */
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly label: SidebarFilterLabeler;
  readonly onChange: SidebarFilterChangeHandler;
}

/** Every filter in menu order, one per field. */
function sidebarFilters(view: SidebarFilterView): SidebarFilter[] {
  const all = [view.project, ...view.state.storedFilters];
  return SIDEBAR_FILTER_FIELDS.flatMap((field) => all.filter((filter) => filter.field === field));
}

function buildSections(view: SidebarFilterView): SidebarFilterSection[] {
  const filters = sidebarFilters(view);
  return SIDEBAR_FILTER_FIELDS.filter(
    (field) => field !== "owner" || view.state.ownerFilterEnabled,
  ).flatMap((field) => {
    const filter = filters.find((candidate) => candidate.field === field);
    const options = buildSidebarFilterOptions({
      field,
      filters,
      groups: view.groups,
      threads: view.state.listedThreads,
      label: (value) => view.label(field, value),
    });
    const selected = filter?.values ?? [];
    // One value cannot narrow anything, but a project is also where a new thread starts.
    const useful = field === "project" ? options.length > 0 : options.length > 1;
    return useful || selected.length > 0
      ? [{ field, operator: filter?.operator ?? "is", selected, options }]
      : [];
  });
}

export function FilterMenu(
  props: {
    readonly view: SidebarFilterView;
    readonly projectRows: SidebarFilterProjectRows;
  } & Pick<ComponentProps<typeof SidebarFilterMenu>, "open" | "onOpenChange">,
) {
  const { view } = props;
  return (
    <SidebarFilterMenu
      open={props.open}
      onOpenChange={props.onOpenChange}
      activeCount={sidebarFilters(view).filter(isActiveSidebarFilter).length}
      buildSections={() => buildSections(view)}
      onChange={view.onChange}
      projectRows={props.projectRows}
    />
  );
}

/** The chips of the active filters, each with the hidden threads that need the user. */
export function FilterChips({ view }: { readonly view: SidebarFilterView }) {
  const active = sidebarFilters(view).filter(isActiveSidebarFilter);
  const hidden =
    active.length === 0
      ? null
      : countHiddenThreadsNeedingUser({
          filters: active,
          groups: view.groups,
          threads: view.state.listedThreads,
        });
  return (
    <SidebarFilterChips
      chips={active.map((filter) => ({
        ...filter,
        labels: filter.values.map((value) => view.label(filter.field, value)),
        hiddenNeedingUser: hidden?.get(filter.field) ?? 0,
      }))}
      onChange={view.onChange}
      onClearAll={view.state.clearFilters}
    />
  );
}

/** Below the header: the filter chips and the sidebar tabs. */
export function HeaderFilterRows({
  filters: view,
  ...tabBar
}: { readonly filters: SidebarFilterView } & ComponentProps<typeof SidebarTabBar>) {
  return (
    <>
      <FilterChips view={view} />
      {tabBar.tabs.enabled ? <SidebarTabBar {...tabBar} /> : null}
    </>
  );
}
