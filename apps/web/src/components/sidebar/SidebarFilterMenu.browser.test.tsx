import {
  EnvironmentId,
  ProjectId,
  type SidebarFilter as StoredSidebarFilter,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { makeThreadFixture } from "../../test-fixtures";
import { applySidebarFilters, type SidebarFilter } from "../filters/sidebarFilters.logic";
import { SidebarProvider } from "../ui/sidebar";
import {
  FilterChips,
  FilterMenu,
  makeSidebarFilterLabeler,
  type SidebarFilterView,
} from "./ForkSidebar";

const mac = EnvironmentId.make("environment-mac");
const vps = EnvironmentId.make("environment-vps");

const groups = buildSidebarProjectSnapshots({
  projects: [mac, vps].map((environmentId) => ({
    id: ProjectId.make("app"),
    environmentId,
    title: "app",
    workspaceRoot: "/work/app",
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    scripts: [],
  })),
  settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: mac,
  resolveEnvironmentLabel: () => null,
});

const threads = [
  makeThreadFixture({
    id: ThreadId.make("on-mac"),
    title: "Thread on the Mac",
    environmentId: mac,
    projectId: ProjectId.make("app"),
  }),
  makeThreadFixture({
    id: ThreadId.make("on-vps"),
    title: "Thread on the VPS",
    environmentId: vps,
    projectId: ProjectId.make("app"),
  }),
];

const label = makeSidebarFilterLabeler({
  projectNameByKey: new Map(groups.map((group) => [group.projectKey, group.displayName])),
  environmentLabelById: new Map([
    [mac, "Mac"],
    [vps, "VPS"],
  ]),
  providerEntriesByEnvironment: new Map(),
});

// The menu, the chips and a list wired as in the sidebar, with the filters in local state.
function Harness() {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<readonly StoredSidebarFilter[]>([]);
  const project: SidebarFilter = { field: "project", operator: "is", values: [] };
  const view: SidebarFilterView = {
    state: {
      ownerFilterEnabled: false,
      listedThreads: threads,
      storedFilters: stored,
      clearFilters: () => setStored([]),
    },
    project,
    groups,
    label,
    onChange: (field, change) => {
      if (field === "project") throw new Error("This test sets no project filter.");
      setStored((current) => [
        ...current.filter((filter) => filter.field !== field),
        ...(change === null ? [] : [{ field, ...change }]),
      ]);
    },
  };
  const shown = applySidebarFilters({ filters: [project, ...stored], groups, threads }).threads;
  return (
    <SidebarProvider>
      <FilterMenu
        view={view}
        open={open}
        onOpenChange={setOpen}
        projectRows={{
          groupByKey: new Map(),
          canPin: () => false,
          togglePin: () => {},
          isPinShortcut: () => false,
          pinShortcutLabel: null,
          openSettings: () => {},
          environmentBadge: null,
        }}
      />
      <FilterChips view={view} />
      <ul aria-label="Threads">
        {shown.map((thread) => (
          <li key={thread.id}>{thread.title}</li>
        ))}
      </ul>
    </SidebarProvider>
  );
}

describe("SidebarFilterMenu", () => {
  it("narrows the list to one machine and shows the filter as a chip", async () => {
    await using screen = await render(<Harness />);
    await expect.element(screen.getByText("Thread on the VPS")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter threads" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Machine/ }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: /Mac/ }));

    await expect.element(screen.getByText("Thread on the VPS")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Thread on the Mac")).toBeVisible();
    const chips = screen.getByRole("group", { name: "Active filters" });
    await expect.element(chips.getByText("Mac", { exact: true })).toBeVisible();
    await expect
      .element(chips.getByRole("button", { name: "Remove the machine filter" }))
      .toBeVisible();
  });
});
