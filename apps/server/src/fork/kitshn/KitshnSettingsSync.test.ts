import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as EnvironmentTheme from "../../environmentTheme.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";

import {
  checkCirclesFromLine,
  circleListFromState,
  circlePartsFromLine,
  sessionCircleLayer,
  withCircleLayer,
} from "./kitshnCircles.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import { registerAnswer } from "./KitshnConnection.testkit.ts";
import { type AccessVisitor, KitshnGrants as KitshnGrantsService } from "./KitshnGrants.ts";
import * as KitshnProvider from "./KitshnProvider.ts";
import {
  circleWriteRefusal,
  effectiveSettings,
  makeCircleList,
  makeSetOne,
  OWNER_SESSION,
  sessionCircleOf,
  sessionWriteCircle,
  type SettingsSession,
  settingsSessionOf,
  sharedPartAfterShare,
  KitshnSettingsSync,
  layer as KitshnSettingsSyncLayer,
} from "./KitshnSettingsSync.ts";

const KitshnProviderService = KitshnProvider.KitshnProvider;

it("applies the shared part, then this machine's part over it", () => {
  expect(
    effectiveSettings({
      shared: { server: { a: 1, b: 1 }, client: { theme: "dark" } },
      machine: { server: { b: 2 }, client: {} },
    }),
  ).toEqual({ server: { a: 1, b: 2 }, client: { theme: "dark" } });
  // A part that is not set, or not in the `{ server, client }` shape, counts as empty.
  expect(effectiveSettings({ shared: null, machine: "broken" })).toEqual({
    server: {},
    client: {},
  });
  expect(effectiveSettings(null)).toEqual({ server: {}, client: {} });
});

it("shares the saved server values and the client values over the shared part", () => {
  expect(
    sharedPartAfterShare(
      { server: { a: 1, keep: true }, client: { chatWidth: "wide" } },
      { a: 2, notSaved: undefined, unasked: 3 },
      { server: ["a", "missing"], client: { chatWidth: "full" } },
    ),
  ).toEqual({ server: { a: 2, keep: true }, client: { chatWidth: "full" } });
});

const desiredLine = (state: unknown) =>
  JSON.stringify({ type: "desired", kind: "t3.settings", state, rev: null });

it("reads Circle, then Environment, then Shared, and only person keys from a circle", () => {
  const parts = {
    shared: { server: { sidebarTabs: "shared", terminalThreads: true }, client: {} },
    machine: { server: { sidebarTabs: "machine" }, client: { followUpBehavior: "queue" } },
  };
  const circles = {
    parts: circlePartsFromLine(
      desiredLine({
        ...parts,
        circles: {
          partner: {
            server: { sidebarTabs: "partner", worktreesDirectory: "/x", terminalThreads: false },
            client: { followUpBehavior: "steer", onboardingCompletedAt: "now" },
          },
          family: { server: { sidebarTabs: "family" }, client: {} },
          broken: "not a part",
        },
      }),
      "t3.settings",
    ),
    list: [{ id: "partner", name: "Partner", color: "#FF5277" }],
  };
  const machine = effectiveSettings(parts);
  // The first circle of the session with a part wins; an unknown circle changes nothing.
  const layer = sessionCircleLayer(circles, ["ghost", "partner", "family"]);
  expect(layer?.circle).toEqual({ id: "partner", name: "Partner", color: "#FF5277" });
  expect(withCircleLayer(machine.server, layer?.settings.server ?? {})).toEqual({
    sidebarTabs: "partner",
    terminalThreads: true,
  });
  expect(withCircleLayer(machine.client, layer?.settings.client ?? {})).toEqual({
    followUpBehavior: "steer",
  });
  // A circle that the state ask did not name shows by its id.
  expect(sessionCircleLayer(circles, ["family"])?.circle).toEqual({
    id: "family",
    name: "family",
    color: null,
  });
  expect(sessionCircleLayer(circles, ["ghost", "broken"])).toBeNull();
  // A session without circles, and a daemon that sends no circle fields, keep Environment.
  expect(sessionCircleLayer(circles, [])).toBeNull();
  expect(circlePartsFromLine(desiredLine(parts), "t3.settings")).toEqual({});
  // The circle row of a session names the saved value below it.
  expect(
    sessionCircleOf(circles, { circles: ["partner"], owner: false }, { sidebarTabs: "own" })
      ?.replaced,
  ).toEqual({ sidebarTabs: "own" });
});

it("reads the circles of a register answer and of each check result", () => {
  const register = JSON.stringify({
    type: "register",
    saved: {
      desired: {
        "t3.settings": { shared: null, machine: null, circles: { a: { server: {}, client: {} } } },
      },
    },
  });
  expect(circlePartsFromLine(register, "t3.settings")).toEqual({
    a: { server: {}, client: {} },
  });
  const check = JSON.stringify({
    type: "check",
    id: "1",
    results: [{ key: "k1", circles: ["a", "b"] }, { key: "k2" }, { key: "k3", circles: "broken" }],
  });
  expect([...checkCirclesFromLine(check)]).toEqual([["k1", ["a", "b"]]]);
});

it("lists the circles that hold a T3 card here, the smallest radius first", () => {
  expect(
    circleListFromState({
      circles: [
        { id: "owner", name: "Owner", r: 400 },
        { id: "partner", name: "Partner", r: 120, color: "#FF5277" },
        { id: "b-kids", name: "Kids", r: 120 },
        { id: "a-kids", name: "Kids too", r: 120 },
        // A code-unit compare puts an upper-case id first; `localeCompare` would not.
        { id: "Z-kids", name: "Kids three", r: 120 },
        { id: "games", name: "Games", r: 50 },
      ],
      cards: [
        { kind: "t3.app", circles: [{ id: "owner" }, { id: "partner" }, { id: "b-kids" }] },
        { kind: "t3.thread", circles: [{ id: "a-kids" }, { id: "Z-kids" }] },
        { kind: "compose", circles: [{ id: "games" }] },
      ],
    })?.map((circle) => circle.id),
  ).toEqual(["Z-kids", "a-kids", "b-kids", "partner", "owner"]);
  expect(circleListFromState({ circles: "broken" })).toBeNull();
});

const visitor = (
  type: AccessVisitor["subject"]["type"],
  app: string,
  circles: ReadonlyArray<string>,
): AccessVisitor => ({
  key: "k",
  headers: {},
  subject: { type, id: "a-ayelet", name: "Ayelet" },
  levels: { app },
  exec: false,
  circles,
  until: 0,
});

it("reads no circle part when the check answer names no circles", () => {
  // A daemon before K-726 passes every circle part on without a filter and names no circles.
  const circles = {
    parts: circlePartsFromLine(
      desiredLine({
        shared: null,
        machine: null,
        circles: { partner: { server: { sidebarTabs: "partner" }, client: {} } },
      }),
      "t3.settings",
    ),
    list: [],
  };
  const session = settingsSessionOf(visitor("person", "standard", []));
  expect(session).toEqual({ circles: [], owner: false });
  expect(sessionCircleLayer(circles, session.circles)).toBeNull();
  expect(sessionWriteCircle(circles, session)).toBeNull();
});

it("knows the owner by the level control, and a machine as no circle writer", () => {
  expect(settingsSessionOf(visitor("person", "standard", ["partner", "family"]))).toEqual({
    circles: ["partner", "family"],
    owner: false,
  });
  // `admin` is the kitshn level `control`, which the owner always holds (K-719). The owner reads
  // no circle, also when kitshn names circles that hold them.
  expect(settingsSessionOf(visitor("person", "admin", ["partner"]))).toEqual(OWNER_SESSION);
  expect(settingsSessionOf(visitor("machine", "admin", ["partner"]))).toEqual({
    circles: [],
    owner: false,
  });
  expect(OWNER_SESSION.owner).toBe(true);
});

it("lets a person who is not the owner write only their own first circle", () => {
  const ayelet = settingsSessionOf(visitor("person", "standard", ["partner", "family"]));
  expect(circleWriteRefusal(ayelet, "partner")).toBeNull();
  expect(circleWriteRefusal(ayelet, "family")).toContain("their own first circle");
  expect(circleWriteRefusal(ayelet, "owner")).toContain("their own first circle");
  expect(circleWriteRefusal({ circles: [], owner: false }, "partner")).not.toBeNull();
  expect(circleWriteRefusal(OWNER_SESSION, "family")).toBeNull();
});

it.effect("stores a circle part for the owner and refuses agents and machine keys", () =>
  Effect.gen(function* () {
    const sent: Array<KitshnConnection.LocalRequestInput> = [];
    const connection = yield* KitshnConnection.make;
    yield* connection.attach({
      answer: registerAnswer(),
      request: (input) =>
        Effect.gen(function* () {
          sent.push(input);
          // kitshn stored the part, so the next `desired` event echoes its rev.
          if (input.type === "desired-set") {
            yield* connection.publish({
              type: "desired",
              kind: input.kind,
              state: { shared: null, machine: null },
              rev: input.rev ?? null,
            });
          }
          return { id: "1", type: "desired-set" as const };
        }),
      notify: () => Effect.void,
    });
    const provider = {
      state: Stream.make({
        settings: null,
        circleParts: { partner: { server: { sidebarTabs: { old: true } }, client: {} } },
        cardSettings: {},
        reach: [],
        syncedAt: null,
        paused: false,
        problems: [],
      }),
    } satisfies Pick<KitshnProvider.KitshnProvider["Service"], "state">;
    const setOne = makeSetOne(provider, connection, Effect.succeed("rev-1"));
    const change = {
      part: "circle",
      circle: "partner",
      scope: "client",
      key: "followUpBehavior",
      value: "steer",
    } as const;

    yield* setOne(change, "owner");
    expect(sent).toEqual([
      {
        type: "desired-set",
        provider: "t3",
        kind: "t3.settings",
        part: "circle",
        circle: "partner",
        value: { server: { sidebarTabs: { old: true } }, client: { followUpBehavior: "steer" } },
        rev: "rev-1",
      },
    ]);
    const agent = yield* Effect.flip(setOne(change, "agent"));
    expect(agent.message).toContain("Agents do not change the settings of a circle");
    const machineKey = yield* Effect.flip(
      setOne({ ...change, scope: "server", key: "forkUpdateMode" }, "owner"),
    );
    expect(machineKey.message).toContain("not a person setting");
    expect(sent).toHaveLength(1);
  }),
);

const PARTNER_PART = {
  server: { mobileSidebarTabs: true },
  client: { followUpBehavior: "steer" },
};
const STATE_ANSWER = {
  circles: [{ id: "partner", name: "Partner", r: 100 }],
  cards: [{ kind: "t3.app", circles: [{ id: "partner" }] }],
};

interface Harness {
  readonly sync: KitshnSettingsSync["Service"];
  /** The requests to the daemon, in order. */
  readonly sent: Array<KitshnConnection.LocalRequestInput>;
  readonly saved: Ref.Ref<ServerSettings>;
  readonly connection: SubscriptionRef.SubscriptionRef<KitshnProvider.KitshnConnectionStatus>;
  /** The answer of the next `state` asks; a failure while it is null. */
  readonly stateAnswer: Ref.Ref<unknown>;
}

/** The real settings service on a fake daemon that stores each part it gets. */
const withSync = <A, E>(
  parts: Record<string, unknown>,
  body: (harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const sent: Array<KitshnConnection.LocalRequestInput> = [];
    const saved = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
    const stateAnswer = yield* Ref.make<unknown>(STATE_ANSWER);
    const providerState = yield* SubscriptionRef.make<KitshnProvider.KitshnProviderState>({
      settings: { shared: null, machine: null },
      circleParts: parts as never,
      cardSettings: {},
      reach: [],
      syncedAt: null,
      paused: false,
      problems: [],
    });
    const connection = yield* SubscriptionRef.make<KitshnProvider.KitshnConnectionStatus>({
      status: "registered",
      detail: null,
      restartedAt: null,
    });
    const kitshn = yield* KitshnConnection.make;
    yield* kitshn.attach({
      answer: registerAnswer(),
      request: (input) =>
        Effect.gen(function* () {
          sent.push(input);
          if (input.type === "ask") {
            const result = yield* Ref.get(stateAnswer);
            return result === null
              ? { id: "1", type: "error" as const, error: "kitshn is away" }
              : { id: "1", type: "ask" as const, outcome: "done" as const, result };
          }
          if (input.type === "desired-set") {
            const circle = (input as { readonly circle?: string }).circle;
            if (circle !== undefined) {
              yield* SubscriptionRef.update(providerState, (state) => {
                const { [circle]: _old, ...rest } = state.circleParts;
                return {
                  ...state,
                  circleParts:
                    input.value === null ? rest : { ...rest, [circle]: input.value as never },
                };
              });
            }
            yield* kitshn.publish({
              type: "desired",
              kind: input.kind,
              state: { shared: null, machine: null },
              rev: input.rev ?? null,
            });
          }
          return { id: "1", type: input.type } as never;
        }),
      notify: () => Effect.void,
    });
    const layer = KitshnSettingsSyncLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(KitshnConnection.KitshnConnection, kitshn),
          Layer.mock(KitshnProviderService)({
            state: SubscriptionRef.changes(providerState),
            connection: SubscriptionRef.changes(connection),
            linkSocket: Effect.succeed(null),
          }),
          Layer.mock(KitshnGrantsService)({
            active: Effect.succeed(true),
            machine: Effect.succeed({ id: "self", name: "Mac" }),
            trustsPeerOrigin: () => false,
            peerOrigins: () => [],
          }),
          Layer.mock(ServerSettingsModule.ServerSettingsService)({ getSettings: Ref.get(saved) }),
          Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
          ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-settings-" }),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    return yield* Effect.gen(function* () {
      const sync = yield* KitshnSettingsSync;
      return yield* body({ sync, sent, saved, connection, stateAnswer });
    }).pipe(Effect.provide(layer));
  });

const firstState = (sync: Harness["sync"], session: SettingsSession) =>
  sync.clientState(session).pipe(Stream.runHead, Effect.map(Option.getOrThrow));

it.effect("sends the circle values and the picker to the owner session only", () =>
  withSync({ partner: PARTNER_PART }, ({ sync }) =>
    Effect.gen(function* () {
      const owner = yield* firstState(sync, OWNER_SESSION);
      expect(owner.owner).toBe(true);
      expect(owner.circles.map((circle) => [circle.id, circle.settings])).toEqual([
        ["partner", PARTNER_PART],
      ]);
      expect(owner.circle).toBeNull();
      expect(owner.settings.client).toEqual({});

      // A person who is not the owner reads their circle, and gets no other circle's values.
      const ayelet = yield* firstState(sync, { circles: ["partner"], owner: false });
      expect(ayelet.owner).toBe(false);
      expect(ayelet.circles).toEqual([]);
      expect(ayelet.circle?.id).toBe("partner");
      expect(ayelet.writesTo?.id).toBe("partner");
      expect(ayelet.settings.client).toEqual({ followUpBehavior: "steer" });
      expect(ayelet.circle?.replaced).toEqual({ mobileSidebarTabs: false });

      // A machine, or a person on a daemon without `circles`, gets neither.
      const machine = yield* firstState(sync, { circles: [], owner: false });
      expect([machine.owner, machine.circles, machine.circle, machine.writesTo]).toEqual([
        false,
        [],
        null,
        null,
      ]);
    }),
  ),
);

it.effect("sends the saved value again when the session's circle drops a key", () =>
  withSync({ partner: PARTNER_PART }, ({ sync, saved }) =>
    Effect.gen(function* () {
      const ayelet: SettingsSession = { circles: ["partner"], owner: false };
      const savedNow = yield* Ref.get(saved);
      const snapshot = yield* sync.sessionServerSettings(ayelet, savedNow);
      expect(snapshot.mobileSidebarTabs).toBe(true);
      const next = yield* sync
        .sessionSettingsChanges(ayelet, { saved: savedNow, snapshot }, Stream.never)
        .pipe(Stream.runHead, Effect.forkChild);
      // The owner resets the circle: its value leaves, so the saved value shows again.
      yield* sync.setCircle(
        { circleId: "partner", server: {}, client: {}, reset: true },
        OWNER_SESSION,
      );
      const update = Option.getOrThrow(yield* Fiber.join(next));
      expect(update.mobileSidebarTabs).toBe(false);
    }),
  ),
);

it.effect("keeps no failed state ask, and keeps a good answer for a while", () =>
  Effect.gen(function* () {
    const asks = yield* Ref.make(0);
    const fails = yield* Ref.make(true);
    const cache = yield* makeCircleList(
      Ref.update(asks, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(fails)),
        Effect.flatMap((fail) => (fail ? Effect.fail("away") : Effect.succeed(STATE_ANSWER))),
      ),
    );
    yield* cache.refresh;
    expect(yield* SubscriptionRef.get(cache.list)).toEqual([]);
    yield* Ref.set(fails, false);
    yield* cache.refresh;
    expect((yield* SubscriptionRef.get(cache.list)).map((circle) => circle.name)).toEqual([
      "Partner",
    ]);
    yield* cache.refresh;
    expect(yield* Ref.get(asks)).toBe(2);
    yield* TestClock.adjust("16 minutes");
    yield* cache.refresh;
    expect(yield* Ref.get(asks)).toBe(3);
  }),
);

it.effect("asks for the circles again when the connection registers", () =>
  withSync({}, ({ sync, connection, stateAnswer }) =>
    Effect.gen(function* () {
      yield* sync.clientState(OWNER_SESSION).pipe(
        Stream.filter((state) => state.circles.some((circle) => circle.name === "Partner")),
        Stream.runHead,
      );
      yield* Ref.set(stateAnswer, {
        ...STATE_ANSWER,
        circles: [{ id: "partner", name: "Partner 2" }],
      });
      yield* SubscriptionRef.set(connection, { status: "connecting", detail: null });
      yield* SubscriptionRef.set(connection, {
        status: "registered",
        detail: null,
        restartedAt: null,
      });
      const named = yield* sync.clientState(OWNER_SESSION).pipe(
        Stream.filter((state) => state.circles.some((circle) => circle.name === "Partner 2")),
        Stream.runHead,
      );
      expect(Option.isSome(named)).toBe(true);
    }),
  ),
);

const desiredSets = (sent: ReadonlyArray<KitshnConnection.LocalRequestInput>) =>
  sent.flatMap((input) => {
    if (input.type !== "desired-set") return [];
    const { rev: _rev, provider: _provider, kind: _kind, type: _type, ...rest } = input;
    return [rest];
  });

it.effect("stores a non-owner's person settings in their circle and the rest as before", () =>
  withSync({ partner: PARTNER_PART }, ({ sync, sent }) =>
    Effect.gen(function* () {
      const ayelet: SettingsSession = { circles: ["partner", "family"], owner: false };
      const rest = yield* sync.writeSessionServerPatch(ayelet, {
        mobileComposerCamera: true,
        forkUpdateMode: "automatic",
      });
      expect(rest).toEqual({ forkUpdateMode: "automatic" });
      yield* sync.share(
        {
          server: ["mobileComposerCamera"],
          client: { followUpBehavior: "queue", loadBalancingEnabled: true },
        },
        ayelet,
      );
      expect(desiredSets(sent)).toEqual([
        {
          part: "circle",
          circle: "partner",
          value: {
            server: { mobileSidebarTabs: true, mobileComposerCamera: true },
            client: { followUpBehavior: "steer" },
          },
        },
        {
          part: "circle",
          circle: "partner",
          value: {
            server: { mobileSidebarTabs: true, mobileComposerCamera: true },
            client: { followUpBehavior: "queue" },
          },
        },
      ]);
      // The owner's patch goes to the settings file whole.
      const owner = yield* sync.writeSessionServerPatch(OWNER_SESSION, {
        mobileComposerCamera: true,
      });
      expect(owner).toEqual({ mobileComposerCamera: true });
      expect(desiredSets(sent)).toHaveLength(2);
    }),
  ),
);

it.effect("sets only a circle that kitshn names here, and a non-owner only their own", () =>
  withSync({}, ({ sync, sent }) =>
    Effect.gen(function* () {
      const change = { server: {}, client: { followUpBehavior: "steer" } };
      // The picker lists a circle once the state ask named it.
      yield* sync.clientState(OWNER_SESSION).pipe(
        Stream.filter((state) => state.circles.length > 0),
        Stream.runHead,
      );
      const ghost = yield* Effect.flip(
        sync.setCircle({ circleId: "ghost", ...change }, OWNER_SESSION),
      );
      expect(ghost.message).toContain("no such circle");
      yield* sync.setCircle({ circleId: "partner", ...change }, OWNER_SESSION);
      const other = yield* Effect.flip(
        sync.setCircle({ circleId: "partner", ...change }, { circles: ["family"], owner: false }),
      );
      expect(other.message).toContain("their own first circle");
      expect(desiredSets(sent)).toEqual([
        {
          part: "circle",
          circle: "partner",
          value: { server: {}, client: { followUpBehavior: "steer" } },
        },
      ]);
    }),
  ),
);
