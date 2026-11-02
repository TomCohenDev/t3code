/** Fork: the desktop app's machines from its kitshn device token (K-1617), as pure decisions. */
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ClientMachine, EnvironmentId } from "@t3tools/contracts";

export interface SavedEnvironment {
  readonly environmentId: EnvironmentId;
  /** The http(s) origin of its saved route, or null. */
  readonly origin: string | null;
  readonly phase: EnvironmentConnectionPhase;
}

export interface DeviceMachinesPlan {
  /** Listed origins that this app manages: they keep the device token. */
  readonly keep: ReadonlyArray<string>;
  /** Listed origins to pair: not saved yet, or saved and refused. The caller backs off. */
  readonly pair: ReadonlyArray<string>;
  /** Managed origins that the list dropped: remove their environment and token. */
  readonly remove: ReadonlyArray<{
    readonly origin: string;
    readonly environmentId: EnvironmentId | null;
  }>;
}

/**
 * Decides which machines to add, pair again and remove. Only `managed`, the origins this app
 * added, ever go, so a hand-saved environment stays. An empty list says nothing about access,
 * for example before cards have addresses, so it removes nothing.
 */
export function planDeviceMachines(input: {
  readonly listed: ReadonlyArray<string>;
  readonly managed: ReadonlySet<string>;
  readonly saved: ReadonlyArray<SavedEnvironment>;
}): DeviceMachinesPlan {
  const savedByOrigin = new Map(
    input.saved.flatMap((environment) =>
      environment.origin === null ? [] : [[environment.origin, environment] as const],
    ),
  );
  const listed = new Set(input.listed);
  const keep: Array<string> = [];
  const pair: Array<string> = [];
  for (const origin of listed) {
    const saved = savedByOrigin.get(origin);
    if (saved !== undefined && !input.managed.has(origin)) continue;
    keep.push(origin);
    if (saved === undefined || saved.phase === "error") pair.push(origin);
  }
  const remove =
    listed.size === 0
      ? []
      : [...input.managed]
          .filter((origin) => !listed.has(origin))
          .map((origin) => ({
            origin,
            environmentId: savedByOrigin.get(origin)?.environmentId ?? null,
          }));
  return { keep, pair, remove };
}

/**
 * The origins of the listed machines that this app adds. This machine's own card is left out:
 * the primary environment already is that machine, under its loopback address.
 */
export function listedOrigins(
  machines: ReadonlyArray<ClientMachine>,
  ownMachineId: string | null,
  originOf: (url: string) => string | null,
): ReadonlyArray<string> {
  return machines.flatMap((machine) =>
    machine.id === ownMachineId ? [] : (originOf(machine.origin) ?? []),
  );
}

/** The least time between two reads of the machine list from the timer, while visible. */
export const LIST_INTERVAL_MS = 5 * 60_000;
/** The least time between two list reads from focus or visibility, so app switches stay cheap. */
export const LIST_EVENT_GAP_MS = 30_000;

/** `event`: the window became visible or got focus. `tick`: the timer. */
export type DeviceSyncTrigger = "event" | "tick";
/** `list`: read the machine list and apply it. `pair`: only pair the managed machines that wait. */
export type DeviceSyncStep = "none" | "list" | "pair";

/**
 * Decides what one sync trigger does. A hidden window and a sync in flight do nothing. A list
 * read that came due while hidden runs on the next event. Pairing retries need no list read.
 */
export function deviceSyncStep(input: {
  readonly trigger: DeviceSyncTrigger;
  readonly hidden: boolean;
  readonly running: boolean;
  readonly lastListAtMs: number | null;
  readonly nowMs: number;
  readonly pairsWaiting: boolean;
}): DeviceSyncStep {
  if (input.hidden || input.running) return "none";
  const gapMs = input.trigger === "tick" ? LIST_INTERVAL_MS : LIST_EVENT_GAP_MS;
  if (input.lastListAtMs === null || input.nowMs - input.lastListAtMs >= gapMs) return "list";
  return input.pairsWaiting ? "pair" : "none";
}
