/**
 * Fork: the T3 settings from kitshn (K-709, K-726). This server applies the shared part, then its
 * own part, to its files. A circle part never reaches the files: each session reads its circle's
 * circle-capable keys over them (`KitshnSettingsSession`).
 */
import type { DesiredParts } from "@kitshn/local";
import {
  circleSettingsOnly,
  isCircleSetting,
  KEYBINDINGS_SETTING_KEY,
  type MachineMapClientState,
  type MachineMapSetCircleSettingsInput,
  type MachineMapSessionCircle,
  type MachineMapShareSettingsInput,
  type MachineMapShareSettingsResult,
  isMachineLocalSetting,
  ScopedSettingValues,
  ServerSettings as ServerSettingsSchema,
  type ServerSettings as ServerSettingsValue,
  ServerSettingsPatch,
  type SettingsCircle,
  type SettingValues,
  withoutMachineLocalSettings,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { applyKeybindingSettings, withSyncedKeybindings } from "../machineMap/keybindingSync.ts";
import {
  applyThemeSettings,
  THEME_SETTING_KEYS,
  withSharedThemes,
} from "../machineMap/themeSync.ts";
import {
  type CircleSettings,
  circleListFromState,
  circleOf,
  sessionCircleLayer,
  withCircleLayer,
} from "./kitshnCircles.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import * as KitshnGrants from "./KitshnGrants.ts";
import { APP_RESOURCE_ID, levelFor } from "./kitshnGrantRules.ts";
import * as KitshnProvider from "./KitshnProvider.ts";

const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const CLIENT_STATE_REFRESH = Duration.seconds(30);
// K-726: one kitshn `state` ask names the circles for a while; renames show after it.
const CIRCLE_LIST_LIFETIME = Duration.minutes(15);
// K-709: the daemon waits up to 60 seconds for kitshn, then the `desired` event echoes the rev.
const STORE_WAIT = Duration.seconds(65);
const encodeServerSettings = Schema.encodeEffect(ServerSettingsSchema);
const encodePatch = Schema.encodeEffect(ServerSettingsPatch);
const decodePatchOption = Schema.decodeUnknownOption(ServerSettingsPatch);
const decodePart = Schema.decodeUnknownOption(ScopedSettingValues);
const EMPTY_PART: ScopedSettingValues = { server: {}, client: {} };

/** What a session brings to the settings chain. */
export interface SettingsSession {
  /**
   * The circles of the session's kitshn visitor, smallest first. Empty for the owner, who reads
   * the shared and machine parts and edits circles with the person picker only. Empty too when
   * the `check` answer has no `circles` (a daemon before K-726), which passes circle parts on
   * without a filter.
   */
  readonly circles: ReadonlyArray<string>;
  /**
   * Writes like the owner: shared and machine parts, and any circle with the person picker.
   * Otherwise circle-capable changes go only into the first circle of `circles`.
   */
  readonly owner: boolean;
}

export const OWNER_SESSION: SettingsSession = { circles: [], owner: true };

/**
 * The session of one WebSocket, set at the upgrade. A session without a kitshn identity is the
 * owner's: local clients and paired devices. Known limit: the circles of an open socket stay as
 * they were at the upgrade; a reconnect reads them again. Revisit if a circle change must apply
 * to open sockets.
 */
export const KitshnSettingsSession = Context.Reference<SettingsSession>(
  "t3/fork/kitshn/KitshnSettingsSession",
  { defaultValue: () => OWNER_SESSION },
);

/**
 * The session of a kitshn visitor. A machine reads and writes no circle. A person or device at
 * the `t3.app` level `admin` (kitshn `control`) is the owner (K-719) and reads no circle.
 */
export const settingsSessionOf = (visitor: KitshnGrants.AccessVisitor): SettingsSession => {
  if (visitor.subject.type === "machine") return { circles: [], owner: false };
  return levelFor("t3.app", APP_RESOURCE_ID, visitor.levels) === "admin"
    ? OWNER_SESSION
    : { circles: visitor.circles, owner: false };
};

/**
 * Why this session may not write the part of `circleId`, or null. kitshn cannot tell the people of
 * one provider apart, so T3 holds the rule: a session that is not the owner's writes only the
 * first circle of its own `check` answer.
 */
export const circleWriteRefusal = (session: SettingsSession, circleId: string): string | null =>
  session.owner || session.circles[0] === circleId
    ? null
    : "A person who is not the owner changes only the settings of their own first circle.";

/** The server values of a circle layer, decoded; a value that does not decode is left out. */
const decodedServerLayer = (layer: SettingValues): Partial<ServerSettingsValue> => {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer)) {
    const patch = Option.getOrUndefined(decodePatchOption({ [key]: value }));
    if (patch !== undefined && Object.hasOwn(patch, key)) {
      decoded[key] = (patch as Record<string, unknown>)[key];
    }
  }
  return decoded as Partial<ServerSettingsValue>;
};

/** The session's circle layer, as clients see it, with the saved server values that it replaced. */
export const sessionCircleOf = (
  circles: CircleSettings,
  session: SettingsSession,
  saved: Readonly<Record<string, unknown>>,
): MachineMapSessionCircle | null => {
  const layer = sessionCircleLayer(circles, session.circles);
  if (layer === null) return null;
  const replaced = Object.fromEntries(
    Object.keys(layer.settings.server).flatMap((key) =>
      Object.hasOwn(saved, key) ? [[key, saved[key]]] : [],
    ),
  );
  return { ...layer.circle, settings: layer.settings, replaced };
};

/** The circle part that a session writes into, or null when it writes like the owner. */
export const sessionWriteCircle = (
  circles: CircleSettings,
  session: SettingsSession,
): SettingsCircle | null => {
  const first = session.circles[0];
  return !session.owner && first !== undefined ? circleOf(circles, first) : null;
};

/** K-709: the shared part, then this machine's part over it. A part that does not decode is empty. */
export const effectiveSettings = (parts: DesiredParts | null): ScopedSettingValues => {
  const part = (value: unknown) =>
    Option.getOrElse(decodePart(value), () => ({ server: {}, client: {} }));
  const shared = part(parts?.shared ?? null);
  const machine = part(parts?.machine ?? null);
  return {
    server: { ...shared.server, ...machine.server },
    client: { ...shared.client, ...machine.client },
  };
};

/** MM-411: the shared part with the saved values of `input.server` and the `input.client` values. */
export const sharedPartAfterShare = (
  shared: ScopedSettingValues,
  savedServer: SettingValues,
  input: MachineMapShareSettingsInput,
): ScopedSettingValues => {
  const server = { ...shared.server };
  for (const key of input.server) {
    if (!isMachineLocalSetting("server", key) && Object.hasOwn(savedServer, key)) {
      server[key] = savedServer[key];
    }
  }
  return {
    server,
    client: { ...shared.client, ...withoutMachineLocalSettings("client", input.client) },
  };
};

/** A circle part with `changes` merged in; only circle-capable keys stay. */
const circlePartAfter = (
  before: ScopedSettingValues | undefined,
  changes: ScopedSettingValues,
): ScopedSettingValues =>
  circleSettingsOnly({
    server: { ...before?.server, ...changes.server },
    client: { ...before?.client, ...changes.client },
  });

/** Why one setting could not be set in `t3.settings`. */
export class KitshnSettingRefused extends Schema.TaggedError<KitshnSettingRefused>()(
  "KitshnSettingRefused",
  { message: Schema.String },
) {}

/** A part of `t3.settings`: the shared part, this machine's part, or the part of one circle. */
export type SettingsPart =
  | { readonly part: "machine" | "shared" }
  | { readonly part: "circle"; readonly circle: string };

export type SettingChange = SettingsPart & {
  readonly scope: "server" | "client";
  readonly key: string;
  /** Undefined clears the key. */
  readonly value: unknown;
};

type DesiredSet = Extract<KitshnConnection.LocalRequestInput, { readonly type: "desired-set" }>;
/**
 * K-709 with circles: a circle part goes as `part: "circle"` with its `circle` id (the "kitshn
 * contract" of the circle settings PR). `@kitshn/local` does not declare it yet; the line is plain
 * JSON, so it reaches the daemon as written.
 */
const desiredSet = (target: SettingsPart, value: unknown, rev: string): DesiredSet =>
  ({
    type: "desired-set",
    provider: KitshnProvider.PROVIDER_NAME,
    kind: KitshnProvider.SETTINGS_KIND,
    value,
    rev,
    ...target,
  }) as DesiredSet;

/**
 * K-709: sets one part of `t3.settings` and waits until kitshn stored it: the next `desired` event
 * of the kind echoes the `rev` of this set.
 */
const storeSettingsPart = (
  kitshn: KitshnConnection.KitshnConnection["Service"],
  rev: string,
  target: SettingsPart,
  value: unknown,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* kitshn.subscribe;
      yield* kitshn.request(desiredSet(target, value, rev));
      const echoed = yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (event) =>
            event.type === "desired" &&
            event.kind === KitshnProvider.SETTINGS_KIND &&
            event.rev === rev,
        }),
        Effect.timeoutOption(STORE_WAIT),
      );
      if (Option.isNone(echoed)) {
        return yield* new KitshnConnection.KitshnRequestError({
          message:
            "kitshn took the setting but did not confirm that it stored it. Check it again later.",
        });
      }
    }),
  );

/** K-709: the rule and the write of `KitshnSettingsSync.setOne`, on this provider connection. */
export const makeSetOne = (
  provider: Pick<KitshnProvider.KitshnProvider["Service"], "state">,
  kitshn: KitshnConnection.KitshnConnection["Service"],
  newRev: Effect.Effect<string>,
) =>
  Effect.fn("KitshnSettingsSync.setOne")(function* (change: SettingChange, by: "owner" | "agent") {
    if (isMachineLocalSetting(change.scope, change.key)) {
      return yield* new KitshnSettingRefused({
        message: `${change.key} belongs to one machine and is not set through kitshn.`,
      });
    }
    if (change.part === "shared" && by === "agent") {
      return yield* new KitshnSettingRefused({
        message:
          "Agents do not change the shared settings of every machine. Set part machine for this machine, or ask the owner to change the shared value in T3 Settings with All environments.",
      });
    }
    if (change.part === "circle" && by === "agent") {
      return yield* new KitshnSettingRefused({
        message:
          "Agents do not change the settings of a circle of people: a circle part reaches every person of the circle, so kitshn holds that change (desired-set-circle) for the owner (K-726). Set part machine for this machine, or ask the owner to change the circle value in T3 Settings with the person picker.",
      });
    }
    if (change.part === "circle" && !isCircleSetting(change.scope, change.key)) {
      return yield* new KitshnSettingRefused({
        message: `${change.key} is not a person setting, so a circle part does not hold it.`,
      });
    }
    const current = yield* provider.state.pipe(Stream.runHead);
    const before: ScopedSettingValues = Option.getOrElse(
      Option.flatMap(current, (state) =>
        change.part === "circle"
          ? Option.some(state.circleParts[change.circle] ?? EMPTY_PART)
          : decodePart(state.settings?.[change.part] ?? null),
      ),
      () => EMPTY_PART,
    );
    const { [change.key]: _old, ...rest } = before[change.scope];
    const next: ScopedSettingValues = {
      ...before,
      [change.scope]: change.value === undefined ? rest : { ...rest, [change.key]: change.value },
    };
    const target: SettingsPart =
      change.part === "circle" ? { part: "circle", circle: change.circle } : { part: change.part };
    yield* storeSettingsPart(kitshn, yield* newRev, target, next).pipe(
      Effect.mapError((error) => new KitshnSettingRefused({ message: error.message })),
    );
  });

export class KitshnSettingsSync extends Context.Service<
  KitshnSettingsSync,
  {
    /** Applies the settings of kitshn for the life of the server. Never fails. */
    readonly run: Effect.Effect<void>;
    /**
     * What a client of this session needs of the kitshn connection, then each change
     * (`machineMap.subscribe`). The settings hold the session's circle layer.
     */
    readonly clientState: (session: SettingsSession) => Stream.Stream<MachineMapClientState>;
    /**
     * MM-411 on kitshn: puts the saved values of these server keys and these client values into
     * the shared part of `t3.settings`. A session that writes to a circle puts only the
     * circle-capable client values into its circle part; its server values got there with the
     * save (`writeSessionServerPatch`). False when this server is not a kitshn provider.
     */
    readonly share: (
      input: MachineMapShareSettingsInput,
      session: SettingsSession,
    ) => Effect.Effect<MachineMapShareSettingsResult>;
    /** The owner sets values of one circle part from T3 Settings. */
    readonly setCircle: (
      input: MachineMapSetCircleSettingsInput,
      session: SettingsSession,
    ) => Effect.Effect<void, KitshnSettingRefused>;
    /** The server settings as this session reads them: its circle layer over the saved values. */
    readonly sessionServerSettings: (
      session: SettingsSession,
      settings: ServerSettingsValue,
    ) => Effect.Effect<ServerSettingsValue>;
    /**
     * The saved settings (`saved`, then `changes`, without a circle layer) as this session reads
     * them, again when its circle layer changes. `snapshot` is what the client has; an equal value
     * is not sent.
     */
    readonly sessionSettingsChanges: <E, R>(
      session: SettingsSession,
      start: { readonly saved: ServerSettingsValue; readonly snapshot: ServerSettingsValue },
      changes: Stream.Stream<ServerSettingsValue, E, R>,
    ) => Stream.Stream<ServerSettingsValue, E, R>;
    /**
     * For a session that writes to a circle: stores the circle-capable keys of a server settings
     * patch in its circle part, and returns the rest for the settings file. Other sessions get the
     * patch back as it was.
     */
    readonly writeSessionServerPatch: (
      session: SettingsSession,
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettingsPatch, KitshnSettingRefused>;
    /**
     * K-709: sets or clears one key of one part. The shared part reaches every machine, also
     * machines whose grants this server cannot see, so an agent never sets it; the owner does.
     * Known limit: an agent shell can still send `desired-set` to the daemon socket itself; only
     * kitshn can close that path (a shared part that only the owner sets).
     */
    readonly setOne: (
      change: SettingChange,
      by: "owner" | "agent",
    ) => Effect.Effect<void, KitshnSettingRefused>;
  }
>()("t3/fork/kitshn/KitshnSettingsSync") {}

const make = Effect.gen(function* () {
  const provider = yield* KitshnProvider.KitshnProvider;
  const kitshn = yield* KitshnConnection.KitshnConnection;
  const grants = yield* KitshnGrants.KitshnGrants;
  const random = yield* SecureRandom.SecureRandom;
  // K-709: a set's mark only needs to differ from the other sets of this server.
  const newRev = random.uuidV4();
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentThemes = yield* EnvironmentTheme.EnvironmentThemeService;

  const reportedServerSettings = Effect.fn("KitshnSettingsSync.reportedServerSettings")(function* (
    current: ServerSettingsValue,
  ) {
    const encoded = yield* encodeServerSettings(
      // Fork machines and clients that read t3.settings decode secret references.
      ServerSettings.redactServerSettingsForClient(current, { secretReferences: true }),
    );
    return yield* withSyncedKeybindings(
      fileSystem,
      config.keybindingsConfigPath,
      withSharedThemes(
        withoutMachineLocalSettings("server", encoded as Record<string, unknown>),
        yield* environmentThemes.current,
      ),
    );
  });

  /** `previous`: the server values that applied before; at start, `values` itself. */
  const applyServerSettings = Effect.fn("KitshnSettingsSync.applyServerSettings")(function* (
    values: SettingValues,
    previous: SettingValues | null,
  ) {
    const current = yield* reportedServerSettings(yield* settings.getSettings);
    const changed: Record<string, unknown> = {};
    const changedThemeSettings: Record<string, unknown> = {};
    const skipped: Array<string> = [];
    for (const [key, value] of Object.entries(values)) {
      if (key === KEYBINDINGS_SETTING_KEY) continue;
      if (THEME_SETTING_KEYS.has(key)) {
        if (stableStringify(current[key]) !== stableStringify(value)) {
          changedThemeSettings[key] = value;
        }
        continue;
      }
      if (isMachineLocalSetting("server", key) || !Object.hasOwn(ServerSettingsPatch.fields, key)) {
        skipped.push(key);
        continue;
      }
      if (stableStringify(current[key]) === stableStringify(value)) continue;
      // One bad value must not block the others.
      const valid = yield* decodePatch({ [key]: value }).pipe(Effect.isSuccess);
      if (valid) changed[key] = value;
      else skipped.push(key);
    }
    if (skipped.length > 0) {
      yield* Effect.logWarning("kitshn settings: skipped settings that do not apply here.", {
        keys: skipped,
      });
    }
    yield* applyKeybindingSettings({
      keybindingsPath: config.keybindingsConfigPath,
      values,
      previous,
      current,
    });
    if (Object.keys(changed).length > 0) {
      yield* settings.updateSettings(yield* decodePatch(changed));
    }
    // After the patch: `t3 theme set` merges into the settings file that the patch wrote.
    yield* applyThemeSettings({
      settingsPath: config.settingsPath,
      themesDir: config.environmentThemesDir,
      changed: changedThemeSettings,
      current,
    });
  });

  // Before kitshn answered, there is no state, so the settings of this server stay as they are.
  const effective = provider.state.pipe(
    Stream.filter((state) => state.settings !== null),
    Stream.map((state) => effectiveSettings(state.settings)),
    Stream.changesWith((left, right) => stableStringify(left) === stableStringify(right)),
  );

  const run: KitshnSettingsSync["Service"]["run"] = Effect.gen(function* () {
    let previous: SettingValues | null = null;
    yield* effective.pipe(
      Stream.runForEach((values) =>
        applyServerSettings(values.server, previous ?? values.server).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              previous = values.server;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("kitshn settings: could not apply the settings.", {
              cause: String(cause),
            }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  // The machine and the link proxy change without an event of their own, so a tick reads them
  // again; the dedupe below sends only a real change.
  const currentState = provider.state.pipe(Stream.runHead);
  const circleList = yield* SubscriptionRef.make<ReadonlyArray<SettingsCircle>>([]);
  const refreshCircleList = yield* Effect.cachedWithTTL(
    kitshn.request({ type: "ask", action: "state", target: "" }).pipe(
      Effect.flatMap((answer) => {
        const list = "result" in answer ? circleListFromState(answer.result) : null;
        return list === null ? Effect.void : SubscriptionRef.set(circleList, list);
      }),
      Effect.ignore,
    ),
    CIRCLE_LIST_LIFETIME,
  );
  const circlesNow: Effect.Effect<CircleSettings> = Effect.all([
    currentState,
    SubscriptionRef.get(circleList),
  ]).pipe(
    Effect.map(([state, list]) => ({
      parts: Option.isSome(state) ? state.value.circleParts : {},
      list,
    })),
  );

  const sessionServerSettings: KitshnSettingsSync["Service"]["sessionServerSettings"] = (
    session,
    settings,
  ) =>
    session.circles.length === 0
      ? Effect.succeed(settings)
      : circlesNow.pipe(
          Effect.map((circles) => {
            const layer = sessionCircleLayer(circles, session.circles);
            return layer === null
              ? settings
              : withCircleLayer(settings, decodedServerLayer(layer.settings.server));
          }),
        );

  const sessionSettingsChanges: KitshnSettingsSync["Service"]["sessionSettingsChanges"] = (
    session,
    start,
    changes,
  ) => {
    if (session.circles.length === 0) return changes;
    const layers = provider.state.pipe(
      Stream.map(
        (state) =>
          sessionCircleLayer({ parts: state.circleParts, list: [] }, session.circles)?.settings
            .server ?? {},
      ),
      Stream.changesWith((left, right) => stableStringify(left) === stableStringify(right)),
    );
    // The circle goes over the saved values at each emit, so a key that leaves it drops back.
    const merged = Stream.zipLatestWith(
      Stream.concat(Stream.make(start.saved), changes),
      layers,
      (saved, layer) => withCircleLayer(saved, decodedServerLayer(layer)),
    );
    return Stream.suspend(() => {
      let sent = stableStringify(start.snapshot);
      return merged.pipe(
        Stream.filter((next) => {
          const key = stableStringify(next);
          if (key === sent) return false;
          sent = key;
          return true;
        }),
      );
    });
  };

  const storeCirclePart = Effect.fn("KitshnSettingsSync.storeCirclePart")(function* (
    session: SettingsSession,
    circleId: string,
    changes: ScopedSettingValues,
    reset: boolean,
  ) {
    const refusal = circleWriteRefusal(session, circleId);
    if (refusal !== null) return yield* new KitshnSettingRefused({ message: refusal });
    const state = yield* currentState;
    const before = reset || Option.isNone(state) ? undefined : state.value.circleParts[circleId];
    yield* storeSettingsPart(
      kitshn,
      yield* newRev,
      { part: "circle", circle: circleId },
      circlePartAfter(before, changes),
    ).pipe(Effect.mapError((error) => new KitshnSettingRefused({ message: error.message })));
  });

  const writeSessionServerPatch: KitshnSettingsSync["Service"]["writeSessionServerPatch"] =
    Effect.fn("KitshnSettingsSync.writeSessionServerPatch")(function* (session, patch) {
      const circle = sessionWriteCircle(yield* circlesNow, session);
      if (circle === null) return patch;
      const circleKeys = Object.keys(patch).filter((key) => isCircleSetting("server", key));
      if (circleKeys.length === 0) return patch;
      const rest = { ...patch } as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const key of circleKeys) {
        picked[key] = rest[key];
        delete rest[key];
      }
      const encoded = yield* encodePatch(picked as ServerSettingsPatch).pipe(
        Effect.mapError((error) => new KitshnSettingRefused({ message: error.message })),
      );
      yield* storeCirclePart(session, circle.id, { server: encoded, client: {} }, false);
      return rest as ServerSettingsPatch;
    });

  const setCircle: KitshnSettingsSync["Service"]["setCircle"] = Effect.fn(
    "KitshnSettingsSync.setCircle",
  )(function* (input, session) {
    const circles = yield* circlesNow;
    // kitshn refuses a circle that holds no card of this provider here (K-726).
    const known =
      circles.list.some((circle) => circle.id === input.circleId) ||
      Object.hasOwn(circles.parts, input.circleId) ||
      !session.owner;
    if (!known) {
      return yield* new KitshnSettingRefused({
        message: "kitshn names no such circle for this machine.",
      });
    }
    yield* storeCirclePart(
      session,
      input.circleId,
      { server: input.server, client: input.client },
      input.reset === true,
    );
  });

  const clientState: KitshnSettingsSync["Service"]["clientState"] = (session) =>
    Stream.zipLatestAll(
      provider.state,
      provider.connection,
      SubscriptionRef.changes(circleList),
      Stream.tick(CLIENT_STATE_REFRESH),
    ).pipe(
      Stream.tap(() => refreshCircleList.pipe(Effect.forkDetach)),
      Stream.mapEffect(([state, connection, list]) =>
        Effect.all([
          grants.active,
          grants.machine,
          provider.linkSocket,
          // The values below a circle layer only explain it; an unreadable file shows none.
          settings.getSettings.pipe(Effect.orElseSucceed(() => ({}))),
        ]).pipe(
          Effect.map(([joined, machine, linkSocket, saved]): MachineMapClientState => {
            const machineValues = effectiveSettings(state.settings);
            const circles: CircleSettings = { parts: state.circleParts, list };
            const circle = sessionCircleOf(circles, session, saved);
            const writesTo = sessionWriteCircle(circles, session);
            return {
              joined,
              machine,
              settings: {
                server: withCircleLayer(machineValues.server, circle?.settings.server ?? {}),
                client: withCircleLayer(machineValues.client, circle?.settings.client ?? {}),
              },
              circle,
              writesTo,
              owner: session.owner,
              // The parts of the circles are for the owner's picker only.
              circles: !session.owner
                ? []
                : [
                    ...list,
                    // A part whose circle the last state ask did not name still shows, by its id.
                    ...Object.keys(state.circleParts)
                      .filter((id) => !list.some((entry) => entry.id === id))
                      .map((id) => circleOf(circles, id)),
                  ].map((entry) => ({ ...entry, settings: state.circleParts[entry.id] ?? null })),
              connection: {
                status: connection.status,
                detail: connection.detail,
                restartedAt: connection.status === "registered" ? connection.restartedAt : null,
                reachedMachines: new Set(state.reach.map((card) => card.machineId)).size,
                linkProxy: linkSocket !== null,
                syncedAt: state.syncedAt,
                paused: state.paused,
                problems: state.problems,
              },
            };
          }),
        ),
      ),
      Stream.changesWith((left, right) => stableStringify(left) === stableStringify(right)),
    );

  const share: KitshnSettingsSync["Service"]["share"] = Effect.fn("KitshnSettingsSync.share")(
    function* (input, session) {
      if (!(yield* grants.active)) return { shared: false };
      const circle = sessionWriteCircle(yield* circlesNow, session);
      if (circle !== null) {
        const client = circleSettingsOnly({ server: {}, client: input.client }).client;
        if (Object.keys(client).length === 0) return { shared: true };
        return yield* storeCirclePart(session, circle.id, { server: {}, client }, false).pipe(
          Effect.as({ shared: true }),
          Effect.catch((error) =>
            Effect.logWarning("kitshn settings: could not store the circle settings.", {
              cause: error.message,
            }).pipe(Effect.as({ shared: false })),
          ),
        );
      }
      const current = yield* reportedServerSettings(yield* settings.getSettings);
      const state = yield* currentState;
      const shared = Option.getOrElse(
        Option.flatMap(state, (value) => decodePart(value.settings?.shared ?? null)),
        () => ({ server: {}, client: {} }),
      );
      return yield* storeSettingsPart(
        kitshn,
        yield* newRev,
        { part: "shared" },
        sharedPartAfterShare(shared, current, input),
      ).pipe(
        Effect.as({ shared: true }),
        Effect.catch((error) =>
          Effect.logWarning("kitshn settings: could not share the settings.", {
            cause: error.message,
          }).pipe(Effect.as({ shared: false })),
        ),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.catch((cause) =>
      Effect.logWarning("kitshn settings: could not read the settings to share.", {
        cause: String(cause),
      }).pipe(Effect.as({ shared: false })),
    ),
  );

  const setOne = makeSetOne(provider, kitshn, newRev);

  return KitshnSettingsSync.of({
    run,
    clientState,
    share,
    setOne,
    setCircle,
    sessionServerSettings,
    sessionSettingsChanges,
    writeSessionServerPatch,
  });
});

export const layer = Layer.effect(KitshnSettingsSync, make);
