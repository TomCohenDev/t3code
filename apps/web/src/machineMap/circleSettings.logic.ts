/**
 * Fork: settings by kitshn circle in T3 Settings, as pure decisions. The owner picks a circle with
 * the person picker; a circle part holds only circle-capable keys (`CIRCLE_SETTINGS`).
 */
import {
  type ClientSettingsPatch,
  isCircleSetting,
  type MachineMapClientState,
  ServerSettingsPatch,
  type ScopedSettingValues,
  type SettingsCircle,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encodeServerPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeServerPatch = Schema.decodeUnknownOption(ServerSettingsPatch);

/** The circles of the person picker: only the owner's sessions get them. */
export function personPickerCircles(
  state: MachineMapClientState | null,
): ReadonlyArray<MachineMapClientState["circles"][number]> {
  return state === null || !state.joined || !state.owner ? [] : state.circles;
}

/**
 * A change for one circle: the circle-capable keys as wire values, and the keys that a circle
 * part cannot hold. Server values go encoded; client values are plain JSON already.
 */
export function circleSettingsChange(
  serverPatch: ServerSettingsPatch,
  clientPatch: ClientSettingsPatch,
): {
  readonly server: Record<string, unknown>;
  readonly client: Record<string, unknown>;
  readonly refused: ReadonlyArray<string>;
} {
  const server = Object.fromEntries(
    Object.entries(serverPatch).filter(([key]) => isCircleSetting("server", key)),
  );
  const client = Object.fromEntries(
    Object.entries(clientPatch).filter(([key]) => isCircleSetting("client", key)),
  );
  const refused = [
    ...Object.keys(serverPatch).filter((key) => !isCircleSetting("server", key)),
    ...Object.keys(clientPatch).filter((key) => !isCircleSetting("client", key)),
  ];
  return {
    server: encodeServerPatch(server as ServerSettingsPatch) as Record<string, unknown>,
    client,
    refused,
  };
}

/** A circle part as settings values, to show over the saved ones. A value that does not decode is left out. */
export function circlePartSettings(part: ScopedSettingValues | null): Partial<UnifiedSettings> {
  if (part === null) return {};
  const server: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(part.server)) {
    const decoded = Option.getOrUndefined(decodeServerPatch({ [key]: value }));
    if (decoded !== undefined && Object.hasOwn(decoded, key)) {
      server[key] = (decoded as Record<string, unknown>)[key];
    }
  }
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the client settings scope, not an RPC client.
  return { ...part.client, ...server } as Partial<UnifiedSettings>;
}

/** The circle row of the inheritance card for one server key of one environment. */
export interface CircleInheritance {
  readonly circle: SettingsCircle;
  /** The circle's value, or undefined when the circle inherits. */
  readonly value: unknown;
  /** The saved value below the circle, when the server sent the session's circle value. */
  readonly below?: unknown;
}

/**
 * With `selectedCircleId` (the owner's person picker), that circle; otherwise the circle layer of
 * this session. Null when the key is not circle-capable or no circle applies.
 */
export function circleInheritance(
  state: MachineMapClientState | null,
  selectedCircleId: string | undefined,
  key: string,
): CircleInheritance | null {
  if (state === null || !isCircleSetting("server", key)) return null;
  if (selectedCircleId !== undefined) {
    const selected = state.circles.find((circle) => circle.id === selectedCircleId);
    if (selected === undefined) return null;
    const { settings, ...circle } = selected;
    return { circle, value: settings?.server[key] };
  }
  if (state.circle === null) return null;
  const { settings, replaced, ...circle } = state.circle;
  return Object.hasOwn(settings.server, key)
    ? { circle, value: settings.server[key], below: replaced[key] }
    : { circle, value: undefined };
}
