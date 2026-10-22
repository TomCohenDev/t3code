import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vite-plus/test";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { arrow, desiredState, PEER, SELF } from "./MachineMap.testkit.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

const threadId = ThreadId.make("thread:cross-machine-limits");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:source"),
  requestNamespace: "provider:source",
  thread: {
    threadId,
    providerSessionId: "provider:source",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
};

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      method: Schema.String,
    }),
  ),
);

const layerStateWith = (arrowsOut: ReadonlyArray<ReturnType<typeof arrow>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      return Layer.mock(MachineMapState.MachineMapState)({
        clientSeen: yield* Queue.unbounded<never>(),
        trustsPeerOrigin: () => false,
        peerOrigins: () => [],
        snapshot: Effect.succeed({
          enabled: true,
          clientAccess: "off",
          portalUrl: "https://portal.example.com",
          token: { clientId: "source-token", secret: "test-secret" },
          saved: {
            desired: {
              ...desiredState({ arrowsOut }),
              self: { ...desiredState({}).self, mapRole: "edit" },
            },
            desiredAtMs: 0,
            handledCommandIds: [],
            pausedTaskIds: [],
            desktopCommands: [],
            pendingRevokes: [],
            pendingClientAccess: null,
          },
        }),
      });
    }),
  );

const layerState = layerStateWith([arrow(SELF, PEER, "admin", { agentTools: true })]);

it.effect("restricted callers cannot borrow an admin arrow or the machine's edit role", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }));
      }),
    );
    const call = (
      scope: McpInvocationContext.McpInvocationScope,
      modes: Parameters<typeof liveThreadShell>[1] = {},
    ) =>
      MachinePeers.MachinePeers.pipe(
        Effect.flatMap((peers) =>
          peers.callTool({ machine: "VPS", tool: "t3_thread_launch", input: {} }),
        ),
        Effect.provide(
          MachinePeers.layer.pipe(
            Layer.provide(layerState),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          ),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(liveThreadShell(threadId, modes)),
          }),
        ),
        Effect.asVoid,
        Effect.flip,
      );
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const error = yield* call(caller, { runtimeMode });
      expect(error.message).toContain("full-access/default");
    }
    const planError = yield* call(caller, { interactionMode: "plan" });
    expect(planError.message).toContain("full-access/default");
    for (const missing of caller.capabilities) {
      const error = yield* call({
        ...caller,
        capabilities: new Set([...caller.capabilities].filter((item) => item !== missing)),
      });
      expect(error._tag).toBe("OrchestratorMcpFailure");
    }
    expect((yield* call(caller, { activeRunId: null })).message).toContain("active thread run");
    const client = { sessionId: "client", label: "test client", access: "read-only" as const };
    expect((yield* call({ ...caller, thread: undefined, client })).message).toContain(
      "full-access/default",
    );
    expect(
      (yield* call({ ...caller, requestNamespace: "machine-session:other" })).message,
    ).toContain("another machine's arrows");
    expect(requests).toEqual([]);
    // The full-access caller still reaches B; the fixture refuses pairing, not authorization.
    expect((yield* call(caller))._tag).toBe("MachinePeerError");
    expect(requests).toEqual([
      "https://t3-vps.example.com/api/auth/cloudflare-access/pairing-credential",
    ]);
  }),
);

it.effect("a caller lowered during pairing sends no MCP request to B", () =>
  Effect.gen(function* () {
    let paired = false;
    const requests: Array<string> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        if (request.url.endsWith("/oauth/token")) {
          paired = true;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "peer-session",
              issued_token_type: AuthAccessTokenType,
              token_type: "Bearer",
              expires_in: 3600,
              scope: "orchestration:read orchestration:write",
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            id: "pairing",
            credential: "test-pairing-credential",
            expiresAt: "2026-12-01T00:00:00.000Z",
          }),
        );
      }),
    );
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected MCP request"));
    const error = yield* MachinePeers.MachinePeers.pipe(
      Effect.flatMap((peers) =>
        peers.callTool({ machine: "VPS", tool: "t3_thread_launch", input: {} }),
      ),
      Effect.provide(
        MachinePeers.layer.pipe(
          Layer.provide(layerState),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.sync(() =>
              liveThreadShell(threadId, {
                interactionMode: paired ? "plan" : "default",
              }),
            ),
        }),
      ),
      Effect.asVoid,
      Effect.flip,
    );
    expect(error.message).toContain("full-access/default");
    expect(requests).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  }),
);

it.effect("a caller lowered during the MCP handshake cannot send work with a cached session", () =>
  Effect.gen(function* () {
    let lowered = false;
    let lowerDuringHandshake = false;
    const calls: Array<string> = [];
    using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") {
        calls.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const message = decodeMessage(init?.body);
      calls.push(message.method);
      if (message.method === "initialize") {
        lowered = lowerDuringHandshake;
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
          { headers: { "mcp-session-id": "test-session" } },
        );
      }
      return message.id === undefined
        ? new Response(null, { status: 202 })
        : Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [] } });
    });
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/oauth/token")
              ? {
                  access_token: "peer-session",
                  issued_token_type: AuthAccessTokenType,
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "orchestration:read orchestration:write",
                }
              : {
                  id: "pairing",
                  credential: "test-pairing-credential",
                  expiresAt: "2026-12-01T00:00:00.000Z",
                },
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const peers = yield* MachinePeers.MachinePeers;
      const call = () =>
        peers
          .callTool({ machine: "VPS", tool: "t3_thread_launch", input: {} })
          .pipe(Effect.match({ onSuccess: () => "allowed", onFailure: (error) => error.message }));
      expect(yield* call()).toBe("allowed");
      expect(calls).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
      calls.length = 0;
      lowerDuringHandshake = true;
      expect(yield* call()).toContain("full-access/default");
      expect(calls).toEqual(["initialize", "notifications/initialized", "DELETE"]);
    }).pipe(
      Effect.provide(
        MachinePeers.layer.pipe(
          Layer.provide(layerState),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.sync(() =>
              liveThreadShell(threadId, {
                interactionMode: lowered ? "plan" : "default",
              }),
            ),
        }),
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(7);
  }),
);

const PEER_ENVIRONMENT = EnvironmentId.make("environment:vps");
const remoteThread = {
  thread: {
    threadId: ThreadId.make("thread:on-vps"),
    projectId: "project:vps",
    title: "Deploy fix",
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: "codex",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: 0,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: null,
  hasMore: false,
};

/** B: the environment descriptor, the pairing and an MCP server that answers `t3_thread_read`. */
const peerServer = () => {
  const tokenBodies: Array<string> = [];
  const toolCalls: Array<unknown> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: PEER_ENVIRONMENT,
            label: "VPS",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: true },
          }),
        );
      }
      if (request.url.endsWith("/oauth/token")) {
        tokenBodies.push(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: "peer-read-session",
            issued_token_type: AuthAccessTokenType,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "orchestration:read",
          }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          id: "pairing",
          credential: "test-pairing-credential",
          expiresAt: "2026-12-01T00:00:00.000Z",
        }),
      );
    }),
  );
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body)) as {
      id?: string;
      method: string;
      params?: unknown;
    };
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "tools/call") toolCalls.push(body.params);
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result:
        body.method === "tools/call"
          ? { content: [], structuredContent: remoteThread }
          : { protocolVersion: "2025-06-18" },
    });
  });
  return { http, fetch, tokenBodies, toolCalls };
};

const withPeers = <A, E>(
  http: HttpClient.HttpClient,
  modes: Parameters<typeof liveThreadShell>[1],
  effect: (
    peers: MachinePeers.MachinePeers["Service"],
  ) => Effect.Effect<
    A,
    E,
    McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
  >,
  state = layerState,
) =>
  MachinePeers.MachinePeers.pipe(
    Effect.flatMap(effect),
    Effect.provide(
      MachinePeers.layer.pipe(
        Layer.provide(state),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId, modes)),
      }),
    ),
  );

it.effect("reads a thread on another machine through the arrow, read-only there (MM-1905)", () =>
  Effect.gen(function* () {
    const peer = peerServer();
    using _fetch = peer.fetch;
    const result = yield* withPeers(peer.http, {}, (peers) =>
      peers.readThread({
        threadId: ThreadId.make("thread:on-vps"),
        environmentId: PEER_ENVIRONMENT,
      }),
    );
    expect(result.thread.title).toBe("Deploy fix");
    // The read session asks B for orchestration:read only, so B caps it at read-only.
    expect(peer.tokenBodies).toHaveLength(1);
    expect(new URLSearchParams(peer.tokenBodies[0]).get("scope")).toBe("orchestration:read");
    // B reads its own thread, so it gets no environment id.
    expect(peer.toolCalls).toEqual([
      { name: "t3_thread_read", arguments: { threadId: "thread:on-vps" } },
    ]);
  }),
);

it.effect("a restricted caller reads another machine but cannot call its tools (MM-1902)", () =>
  Effect.gen(function* () {
    const peer = peerServer();
    using _fetch = peer.fetch;
    const plan = { interactionMode: "plan" } as const;
    const read = yield* withPeers(peer.http, plan, (peers) =>
      peers.readThread({
        threadId: ThreadId.make("thread:on-vps"),
        environmentId: PEER_ENVIRONMENT,
      }),
    );
    expect(read.thread.threadId).toBe("thread:on-vps");
    const write = yield* withPeers(peer.http, plan, (peers) =>
      peers
        .callTool({ machine: "VPS", tool: "t3_thread_send", input: {} })
        .pipe(Effect.asVoid, Effect.flip),
    );
    expect(write.message).toContain("full-access/default");
    expect(peer.toolCalls).toHaveLength(1);
  }),
);

it.effect("refuses a thread read without an arrow with agent tools, with no request", () =>
  Effect.gen(function* () {
    const peer = peerServer();
    using _fetch = peer.fetch;
    const requests: Array<string> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => requests.push(request.url)).pipe(
        Effect.andThen(peer.http.execute(request)),
      ),
    );
    const noAgentTools = layerStateWith([arrow(SELF, PEER, "admin")]);
    const error = yield* withPeers(
      http,
      {},
      (peers) =>
        peers
          .readThread({ threadId: ThreadId.make("thread:on-vps"), environmentId: PEER_ENVIRONMENT })
          .pipe(Effect.flip),
      noAgentTools,
    );
    expect(error._tag).toBe("MachinePeerError");
    expect(error.message).toContain("No arrow with agent tools");
    expect(requests).toEqual([]);
    expect(peer.toolCalls).toEqual([]);
  }),
);
