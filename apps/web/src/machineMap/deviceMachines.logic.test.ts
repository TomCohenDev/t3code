import { EnvironmentId, MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deviceSyncStep,
  LIST_EVENT_GAP_MS,
  LIST_INTERVAL_MS,
  listedOrigins,
  planDeviceMachines,
  type SavedEnvironment,
} from "./deviceMachines.logic";

const VPS = "https://t3-vps.example.com";
const MAC = "https://t3-mac.example.com";

const saved = (
  origin: string,
  phase: SavedEnvironment["phase"] = "connected",
): SavedEnvironment => ({
  environmentId: EnvironmentId.make(origin),
  origin,
  phase,
});

describe("planDeviceMachines", () => {
  it("pairs a new or refused managed machine and leaves a hand-saved one alone", () => {
    expect(
      planDeviceMachines({
        listed: [VPS, MAC],
        managed: new Set([VPS]),
        saved: [saved(VPS, "error"), saved(MAC)],
      }),
    ).toEqual({ keep: [VPS], pair: [VPS], remove: [] });
  });

  it("removes a managed machine that the list dropped, but nothing for an empty list", () => {
    const managed = new Set([VPS, MAC]);
    expect(
      planDeviceMachines({ listed: [VPS], managed, saved: [saved(VPS), saved(MAC)] }).remove,
    ).toEqual([{ origin: MAC, environmentId: EnvironmentId.make(MAC) }]);
    expect(planDeviceMachines({ listed: [], managed, saved: [saved(VPS)] }).remove).toEqual([]);
  });
});

describe("listedOrigins", () => {
  it("never adds this machine's own card a second time", () => {
    const machines = [
      { id: MachineId.make("mac"), name: "Mac", origin: `${MAC}/` },
      { id: MachineId.make("vps"), name: "VPS", origin: VPS },
    ];
    const originOf = (url: string) => URL.parse(url)?.origin ?? null;
    expect(listedOrigins(machines, "mac", originOf)).toEqual([VPS]);
    expect(listedOrigins(machines, null, originOf)).toEqual([MAC, VPS]);
  });
});

describe("deviceSyncStep", () => {
  const visible = {
    hidden: false,
    running: false,
    lastListAtMs: 0,
    pairsWaiting: false,
  } as const;

  it("reads nothing while hidden, and reads on the next event after a due interval", () => {
    const nowMs = LIST_INTERVAL_MS * 3;
    expect(deviceSyncStep({ ...visible, hidden: true, trigger: "tick", nowMs })).toBe("none");
    expect(
      deviceSyncStep({ ...visible, hidden: true, trigger: "event", nowMs, pairsWaiting: true }),
    ).toBe("none");
    expect(deviceSyncStep({ ...visible, trigger: "event", nowMs })).toBe("list");
    expect(deviceSyncStep({ ...visible, trigger: "event", lastListAtMs: null, nowMs: 0 })).toBe(
      "list",
    );
  });

  it("reads at most once per interval from the timer, and only retries waiting pairs between", () => {
    const due = { ...visible, trigger: "tick" } as const;
    expect(deviceSyncStep({ ...due, nowMs: LIST_INTERVAL_MS - 1 })).toBe("none");
    expect(deviceSyncStep({ ...due, nowMs: LIST_INTERVAL_MS - 1, pairsWaiting: true })).toBe(
      "pair",
    );
    expect(deviceSyncStep({ ...due, nowMs: LIST_INTERVAL_MS })).toBe("list");
  });

  it("does not read twice for a focus right after a visibility change", () => {
    const event = { ...visible, trigger: "event" } as const;
    expect(deviceSyncStep({ ...event, running: true, lastListAtMs: null, nowMs: 0 })).toBe("none");
    expect(deviceSyncStep({ ...event, nowMs: LIST_EVENT_GAP_MS - 1 })).toBe("none");
    expect(deviceSyncStep({ ...event, nowMs: LIST_EVENT_GAP_MS })).toBe("list");
  });
});
