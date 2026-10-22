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

const layerState = Layer.unwrap(
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
            ...desiredState({ arrowsOut: [arrow(SELF, PEER, "admin", { agentTools: true })] }),
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
