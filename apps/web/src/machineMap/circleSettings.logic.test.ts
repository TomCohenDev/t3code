import type { MachineMapClientState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  circleInheritance,
  circleSettingsChange,
  personPickerCircles,
} from "./circleSettings.logic";

const partner = { id: "partner", name: "Partner", color: null };

const state = (overrides: Partial<MachineMapClientState>): MachineMapClientState => ({
  joined: true,
  machine: null,
  settings: { server: {}, client: {} },
  circle: null,
  writesTo: null,
  circles: [{ ...partner, settings: { server: { mobileSidebarTabs: true }, client: {} } }],
  connection: {
    status: "registered",
    detail: null,
    restartedAt: null,
    reachedMachines: 0,
    linkProxy: false,
    syncedAt: null,
    paused: false,
    problems: [],
  },
  ...overrides,
});

describe("circle settings", () => {
  it("offers the picker to the owner only", () => {
    expect(personPickerCircles(state({})).map((circle) => circle.id)).toEqual(["partner"]);
    expect(personPickerCircles(state({ writesTo: partner }))).toEqual([]);
    expect(personPickerCircles(state({ joined: false }))).toEqual([]);
    expect(personPickerCircles(null)).toEqual([]);
  });

  it("keeps only person settings in a circle change", () => {
    expect(
      circleSettingsChange(
        { mobileSidebarTabs: true, forkUpdateMode: "automatic" },
        { followUpBehavior: "steer", loadBalancingEnabled: true },
      ),
    ).toEqual({
      server: { mobileSidebarTabs: true },
      client: { followUpBehavior: "steer" },
      refused: ["forkUpdateMode", "loadBalancingEnabled"],
    });
  });

  it("reads the picked circle, else the session's circle layer, for a person setting", () => {
    expect(circleInheritance(state({}), "partner", "mobileSidebarTabs")).toEqual({
      circle: partner,
      value: true,
    });
    expect(circleInheritance(state({}), "partner", "forkUpdateMode")).toBeNull();
    const session = state({
      circle: {
        ...partner,
        settings: { server: { mobileSidebarTabs: true }, client: {} },
        replaced: { mobileSidebarTabs: false },
      },
    });
    expect(circleInheritance(session, undefined, "mobileSidebarTabs")).toEqual({
      circle: partner,
      value: true,
      below: false,
    });
    expect(circleInheritance(session, undefined, "sidebarTabs")).toEqual({
      circle: partner,
      value: undefined,
    });
  });
});
