import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  checkCirclesFromLine,
  circleListFromState,
  circlePartsFromLine,
  sessionCircleLayer,
  withCircleLayer,
} from "./kitshnCircles.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import { registerAnswer } from "./KitshnConnection.testkit.ts";
import type { AccessVisitor } from "./KitshnGrants.ts";
import type * as KitshnProvider from "./KitshnProvider.ts";
import {
  circleWriteRefusal,
  effectiveSettings,
  makeSetOne,
  OWNER_SESSION,
  sessionCircleOf,
  sessionWriteCircle,
  settingsSessionOf,
  sharedPartAfterShare,
} from "./KitshnSettingsSync.ts";

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
        { id: "games", name: "Games", r: 50 },
      ],
      cards: [
        { kind: "t3.app", circles: [{ id: "owner" }, { id: "partner" }, { id: "b-kids" }] },
        { kind: "t3.thread", circles: [{ id: "a-kids" }] },
        { kind: "compose", circles: [{ id: "games" }] },
      ],
    })?.map((circle) => circle.id),
  ).toEqual(["a-kids", "b-kids", "partner", "owner"]);
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
  // `admin` is the kitshn level `control`, which the owner always holds (K-719).
  expect(settingsSessionOf(visitor("person", "admin", ["owner"]))).toEqual({
    circles: ["owner"],
    owner: true,
  });
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
