import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { moveLegacyForkClientSettingKeys, moveLegacySidebarOwnerFilter } from "./forkSettings.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ClientSettings sidebar filters", () => {
  it("filters nothing by default and keeps each filter through a save", () => {
    expect(decodeClientSettings({}).sidebarFilters).toEqual([]);
    const filters = [
      { field: "owner", operator: "is_not", values: ["qlik-trial", ""] },
      { field: "model", operator: "is", values: ["codex:gpt-5"] },
    ];
    const saved = encodeClientSettings(decodeClientSettings({ sidebarFilters: filters }));
    expect(decodeClientSettings(saved).sidebarFilters).toEqual(filters);
    expect(decodeClientSettingsPatch({ sidebarFilters: filters }).sidebarFilters).toEqual(filters);
    expect(() =>
      decodeClientSettingsPatch({
        sidebarFilters: [{ field: "owner", operator: "contains", values: [] }],
      }),
    ).toThrow();
  });
});

describe("moveLegacySidebarOwnerFilter", () => {
  it.each([
    {
      name: "moves owners into an owner filter, with null as the empty string",
      stored: { sidebarOwnerFilter: { operator: "is_not", owners: ["qlik-trial", null] } },
      moved: {
        sidebarFilters: [{ field: "owner", operator: "is_not", values: ["qlik-trial", ""] }],
      },
    },
    {
      name: "drops a filter without owners",
      stored: { sidebarOwnerFilter: { operator: "is", owners: [] }, wordWrap: false },
      moved: { wordWrap: false },
    },
    {
      name: "drops a malformed filter",
      stored: { sidebarOwnerFilter: { operator: "contains", owners: ["a"] } },
      moved: {},
    },
    {
      name: "keeps a value under the new key",
      stored: { sidebarOwnerFilter: { owners: ["a"] }, sidebarFilters: [] },
      moved: { sidebarFilters: [] },
    },
  ])("$name", ({ stored, moved }) => {
    expect(moveLegacySidebarOwnerFilter(stored)).toEqual(moved);
    expect(decodeClientSettings(moved)).not.toHaveProperty("sidebarOwnerFilter");
  });

  it("returns null without the old key, so a caller writes only after a move", () => {
    expect(moveLegacySidebarOwnerFilter({ sidebarFilters: [] })).toBeNull();
    expect(moveLegacyForkClientSettingKeys({ wordWrap: true })).toBeNull();
  });

  it("moves the sidebar tab keys and the owner filter in one pass", () => {
    expect(
      moveLegacyForkClientSettingKeys({
        sidebarGroupsEnabled: true,
        sidebarOwnerFilter: { owners: ["a"] },
      }),
    ).toEqual({
      sidebarTabsEnabled: true,
      sidebarFilters: [{ field: "owner", operator: "is", values: ["a"] }],
    });
  });
});

describe("ClientSettings removed fork settings", () => {
  it("decodes saved settings that still hold a removed key, and drops the key", () => {
    const settings = decodeClientSettings({ richContextMenu: false });
    expect(settings).not.toHaveProperty("richContextMenu");
    expect(encodeClientSettings(settings)).not.toHaveProperty("richContextMenu");
  });
});

describe("ServerSettings agent session import limits", () => {
  it("defaults to a 30 day window and 200 messages", () => {
    expect(decodeServerSettings({})).toMatchObject({
      agentSessionImportWindowDays: 30,
      agentSessionImportMaxMessages: 200,
    });
  });

  it("accepts the range bounds", () => {
    expect(
      decodeServerSettingsPatch({
        agentSessionImportWindowDays: 3650,
        agentSessionImportMaxMessages: 1,
      }),
    ).toEqual({ agentSessionImportWindowDays: 3650, agentSessionImportMaxMessages: 1 });
  });

  it.each([0, -1, 1.5, 3651])("rejects an import window of %s days", (value) => {
    expect(() => decodeServerSettings({ agentSessionImportWindowDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ agentSessionImportWindowDays: value })).toThrow();
  });

  it.each([0, -1, 2.5, 10_001, null])("rejects a message limit of %s", (value) => {
    expect(() => decodeServerSettings({ agentSessionImportMaxMessages: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ agentSessionImportMaxMessages: value })).toThrow();
  });
});

describe("ServerSettings.pullRequestWatchRemarkFilter", () => {
  it("filters nothing by default and reads a saved filter", () => {
    expect(decodeServerSettings({}).pullRequestWatchRemarkFilter).toEqual({
      authorAssociations: [],
      authorLogins: [],
      agentMarker: "",
    });
    expect(
      decodeServerSettings({
        pullRequestWatchRemarkFilter: {
          authorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
          agentMarker: " <!-- agent --> ",
        },
      }).pullRequestWatchRemarkFilter,
    ).toEqual({
      authorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
      authorLogins: [],
      agentMarker: "<!-- agent -->",
    });
    expect(() =>
      decodeServerSettingsPatch({
        pullRequestWatchRemarkFilter: { authorAssociations: ["ADMIN"] },
      }),
    ).toThrow();
  });
});

describe("ServerSettings global scripts and pins", () => {
  const script = {
    id: "lint",
    name: "Lint",
    command: "vp lint",
    icon: "lint",
    runOnWorktreeCreate: false,
  };

  it("defaults to no global scripts and no pins", () => {
    const settings = decodeServerSettings({});
    expect(settings.globalScripts).toEqual([]);
    expect(settings.pinnedGlobalScriptIds).toEqual([]);
    expect(settings.pinnedProjectScriptIds).toEqual({});
  });

  it("accepts global scripts and pin entries", () => {
    const settings = decodeServerSettings({
      globalScripts: [script],
      pinnedGlobalScriptIds: ["lint"],
      pinnedProjectScriptIds: { "project-1": ["dev", "test"] },
    });
    expect(settings.globalScripts).toEqual([script]);
    expect(settings.pinnedProjectScriptIds["project-1" as ProjectId]).toEqual(["dev", "test"]);
  });

  it("rejects malformed global scripts and pin entries", () => {
    expect(() => decodeServerSettings({ globalScripts: [{ ...script, command: " " }] })).toThrow();
    expect(() => decodeServerSettings({ pinnedGlobalScriptIds: [""] })).toThrow();
    expect(() =>
      decodeServerSettings({ pinnedProjectScriptIds: { "project-1": "dev" } }),
    ).toThrow();
  });

  it("lets a patch remove one project's pins with null", () => {
    expect(
      decodeServerSettingsPatch({ pinnedProjectScriptIds: { "project-1": null } })
        .pinnedProjectScriptIds,
    ).toEqual({ "project-1": null });
  });
});
