/**
 * Fork: machine map. This server as a client of other machines. It pairs with a peer through the
 * tunnel hostname of the peer, with this machine's token as request headers, the same way the
 * desktop app does (MM-306). The peer gives the session the scopes of the arrow (MM-1305).
 */
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationReadScope,
  AuthPairingCredentialResult,
  AuthTokenExchangeGrantType,
  type EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type MachineExecInput,
  MachineExecResult,
  type MachineId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  type PeerMachine,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { mcpToolSession } from "../../mcp/AcpMcpStdioBridge.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { arrowAllowsExec, effectiveLevel, reachablePeers } from "./machineAccess.ts";
import {
  historyCaller,
  requireMachineThreadReader,
  requireMachineToolCaller,
} from "./machineCallerAccess.ts";
import * as MachineMapState from "./MachineMapState.ts";

const REQUEST_TIMEOUT = Duration.seconds(15);
// An offline peer must not hold up the `@` menu of every client for the full request timeout.
const DESCRIPTOR_TIMEOUT = Duration.seconds(5);

export class MachinePeerError extends Schema.TaggedError<MachinePeerError>()("MachinePeerError", {
  reason: Schema.Literals([
    "not-on-map",
    "unknown-machine",
    "unknown-environment",
    "no-agent-tools",
    "no-arrow",
    "no-exec",
    "no-hostname",
    "pairing-refused",
    "unreachable",
    "tool-failed",
  ]),
  /** A message safe to show to the agent or the portal. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** MM-307: the result of `testArrow`, for the portal. */
export interface ArrowTestResult {
  readonly to: MachineId;
  readonly reachable: boolean;
  /** The round trip of the pairing request, through Cloudflare Access and the tunnel. */
  readonly roundTripMs: number | null;
  readonly scopes: ReadonlyArray<string>;
  readonly error: string | null;
}

interface PeerSession {
  readonly accessToken: string;
  readonly scopes: ReadonlyArray<string>;
}

/**
 * `read` asks the peer for `orchestration:read` only. The peer then caps the MCP session at
 * read-only (MM-1902), so a restricted caller reads there and every write is refused there.
 */
type SessionKind = "full" | "read";

/** MM-1907: a machine whose threads this machine can read, for the `@` menu of its clients. */
export interface ReadableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly machineId: MachineId;
  readonly name: string;
}

type ReaderServices =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagement.ThreadManagementService;

export class MachinePeers extends Context.Service<
  MachinePeers,
  {
    /** MM-307: pair with the target of an arrow from this machine and report what it granted. */
    readonly testArrow: (to: MachineId) => Effect.Effect<ArrowTestResult>;
    /** MM-801 `machine_tool_call`: call a T3 tool on a peer whose arrow has agent tools. */
    readonly callTool: (input: {
      readonly machine: string;
      readonly tool: string;
      readonly input: Readonly<Record<string, unknown>>;
    }) => Effect.Effect<unknown, MachinePeerError | OrchestratorMcpFailure, ReaderServices>;
    /** POST a JSON body to a route of a peer that an arrow from this machine reaches. */
    readonly postJson: (input: {
      readonly machine: string;
      readonly path: string;
      readonly body: string;
    }) => Effect.Effect<void, MachinePeerError>;
    /**
     * MM-1905: `t3_thread_read` of a thread on the machine with `environmentId`, through the arrow
     * with agent tools and a read-only session. Restricted callers may read (MM-1902).
     */
    readonly readThread: (
      input: OrchestratorMcpThreadReadInput & { readonly environmentId: EnvironmentId },
    ) => Effect.Effect<
      OrchestratorMcpThreadReadResult,
      MachinePeerError | OrchestratorMcpFailure,
      ReaderServices
    >;
    /**
     * MM-1908: `machine_exec` on a peer whose arrow allows exec. The peer checks the arrow again,
     * runs the command and reports it to the portal.
     */
    readonly exec: (
      input: MachineExecInput,
    ) => Effect.Effect<
      MachineExecResult,
      MachinePeerError | OrchestratorMcpFailure,
      ReaderServices
    >;
    /** MM-1907: the peers whose threads `readThread` reaches now. Unreachable peers are left out. */
    readonly readableEnvironments: Effect.Effect<ReadonlyArray<ReadableEnvironment>>;
  }
>()("t3/fork/machineMap/MachinePeers") {}

const peerOrigin = (peer: PeerMachine & { readonly hostname: string }) =>
  `https://${peer.hostname}`;

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeFailureText = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorMcpFailure));

/** The structured result of a peer tool, or its failure as the peer reported it. */
const decodePeerResult = Effect.fn("MachinePeers.decodePeerResult")(function* <A>(
  raw: unknown,
  schema: Schema.Decoder<A>,
  tool: string,
  peerName: string,
) {
  const unexpected = new MachinePeerError({
    reason: "tool-failed",
    detail: `${peerName} sent a ${tool} result that this machine cannot read. Update both machines to the same T3 Code version.`,
  });
  const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected));
  if (result.isError === true) {
    const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
    return yield* decodeFailureText(text).pipe(
      Effect.mapError(
        () =>
          new MachinePeerError({
            reason: "tool-failed",
            detail: `${tool} on ${peerName} failed: ${text.slice(0, 500)}`,
          }),
      ),
      Effect.flatMap(Effect.fail),
    );
  }
  return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
    Effect.mapError(() => unexpected),
  );
});

const make = Effect.gen(function* () {
  const state = yield* MachineMapState.MachineMapState;
  const httpClient = yield* HttpClient.HttpClient;
  // One session per peer and kind, so repeated tool calls do not pile up sessions on the peer. A
  // level change on the peer revokes it (MM-1306); the next call then pairs again.
  const sessions = new Map<`${MachineId}:${SessionKind}`, PeerSession>();
  // A peer keeps its environment id across restarts. Known limit: a peer reinstalled with a new
  // environment id keeps its old entry until a lookup of the new id misses and probes again.
  const environmentIds = new Map<MachineId, EnvironmentId>();

  const resolvePeer = Effect.fn("MachinePeers.resolvePeer")(function* (machine: string) {
    const local = yield* state.snapshot;
    const desired = local.enabled ? local.saved.desired : null;
    if (desired === null || local.token === null) {
      return yield* new MachinePeerError({
        reason: "not-on-map",
        detail: "This machine is not on the machine map. Join it first.",
      });
    }
    const wanted = machine.trim().toLowerCase();
    const peer = desired.peers.find(
      (candidate) => candidate.id === machine || candidate.name.toLowerCase() === wanted,
    );
    if (peer === undefined || peer.id === desired.self.id) {
      return yield* new MachinePeerError({
        reason: "unknown-machine",
        detail: `No other machine named "${machine}" is on the map.`,
      });
    }
    if (peer.hostname === null) {
      return yield* new MachinePeerError({
        reason: "no-hostname",
        detail: `${peer.name} has not reported its tunnel hostname yet.`,
      });
    }
    const arrow = desired.arrowsOut.find(
      (candidate) => candidate.from === desired.self.id && candidate.to === peer.id,
    );
    return {
      peer: { ...peer, hostname: peer.hostname },
      arrow,
      token: local.token,
      selfName: desired.self.name,
    };
  });

  const pair = Effect.fn("MachinePeers.pair")(function* (
    peer: PeerMachine & { readonly hostname: string },
    token: MachineMapState.MachineToken,
    selfName: string,
    kind: SessionKind,
  ) {
    const origin = peerOrigin(peer);
    const headers = MachineMapState.tokenHeaders(token);
    const credential = yield* HttpClientRequest.post(
      `${origin}/api/auth/cloudflare-access/pairing-credential`,
    ).pipe(
      HttpClientRequest.setHeaders(headers),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    const exchanged = yield* HttpClientRequest.post(`${origin}/oauth/token`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: `machine ${selfName}`,
        client_device_type: "bot",
        ...(kind === "read" ? { scope: AuthOrchestrationReadScope } : {}),
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    const session: PeerSession = {
      accessToken: exchanged.access_token,
      scopes: exchanged.scope.split(" ").filter((scope) => scope.length > 0),
    };
    sessions.set(`${peer.id}:${kind}`, session);
    return session;
  });

  const describe = (cause: unknown): string => {
    if (HttpClientError.isHttpClientError(cause)) {
      return cause.response === undefined ? cause.reason._tag : `HTTP ${cause.response.status}`;
    }
    return Predicate.isTagged(cause, "TimeoutError") ? "timed out" : "unexpected response";
  };

  const testArrow: MachinePeers["Service"]["testArrow"] = Effect.fn("MachinePeers.testArrow")(
    function* (to) {
      const resolved = yield* resolvePeer(to);
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* pair(resolved.peer, resolved.token, resolved.selfName, "full").pipe(
        Effect.flatMap((session) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((endedAt): ArrowTestResult => ({
              to,
              reachable: true,
              roundTripMs: endedAt - startedAt,
              scopes: session.scopes,
              error: null,
            })),
          ),
        ),
        Effect.catch((cause) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((endedAt): ArrowTestResult => {
              const detail = describe(cause);
              // Access answers 403 and the peer answers 401 when the arrow grants nothing.
              const refused = detail === "HTTP 401" || detail === "HTTP 403";
              return {
                to,
                reachable: refused,
                roundTripMs: refused ? endedAt - startedAt : null,
                scopes: [],
                error: refused ? `${detail}: the arrow grants no access` : detail,
              };
            }),
          ),
        ),
      );
    },
    (effect, to) =>
      effect.pipe(
        Effect.catchTags({
          MachinePeerError: (error) =>
            Effect.succeed({
              to,
              reachable: false,
              roundTripMs: null,
              scopes: [],
              error: error.detail,
            } satisfies ArrowTestResult),
        }),
      ),
  );

  const requireAgentTools = Effect.fn("MachinePeers.requireAgentTools")(function* (
    resolved: Effect.Success<ReturnType<typeof resolvePeer>>,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      resolved.arrow === undefined ||
      !resolved.arrow.agentTools ||
      effectiveLevel(resolved.arrow, nowMs) === "none"
    ) {
      return yield* new MachinePeerError({
        reason: "no-agent-tools",
        detail: `The arrow from this machine to ${resolved.peer.name} does not allow agent tools.`,
      });
    }
  });

  /**
   * One MCP call on a peer. `check` runs again before pairing, after the MCP handshake and before
   * the retry, because the caller's modes can change while it waits (MM-1904).
   */
  const callPeer = Effect.fn("MachinePeers.callPeer")(function* (input: {
    readonly resolved: Effect.Success<ReturnType<typeof resolvePeer>>;
    readonly kind: SessionKind;
    readonly check: Effect.Effect<void, OrchestratorMcpFailure, ReaderServices>;
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
  }) {
    const { resolved, kind, check } = input;
    const headers = MachineMapState.tokenHeaders(resolved.token);
    const call = Effect.fn("MachinePeers.call")(function* (session: PeerSession) {
      yield* check;
      const remote = yield* mcpToolSession({
        endpoint: `${peerOrigin(resolved.peer)}/mcp`,
        authorization: `Bearer ${session.accessToken}`,
        clientName: "t3-code-machine-peer",
        // Cloudflare Access in front of the peer needs the machine token on every request.
        fetchImplementation: (url, init) =>
          // @effect-diagnostics-next-line globalFetch:off - the MCP bridge takes a fetch function; this only adds the Access headers.
          fetch(url, { ...init, headers: { ...(init?.headers as object), ...headers } }),
      });
      // Initializing MCP waits on B too; a downgrade during that wait must stop tools/call.
      yield* check;
      return yield* remote.call(input.tool, input.input);
    }, Effect.scoped);
    const pairOrFail = check.pipe(
      Effect.andThen(
        pair(resolved.peer, resolved.token, resolved.selfName, kind).pipe(
          Effect.mapError(
            (cause) =>
              new MachinePeerError({
                reason: "pairing-refused",
                detail: `${resolved.peer.name} refused the pairing: ${describe(cause)}.`,
              }),
          ),
        ),
      ),
    );
    const key = `${resolved.peer.id}:${kind}` as const;
    const cached = sessions.get(key);
    const first = cached ?? (yield* pairOrFail);
    return yield* call(first).pipe(
      // The bridge reports a revoked session only in its message. Pair again once.
      Effect.catch((error) =>
        cached !== undefined && error.message.includes("HTTP 401")
          ? Effect.sync(() => sessions.delete(key)).pipe(
              Effect.andThen(pairOrFail),
              Effect.flatMap(call),
            )
          : Effect.fail(error),
      ),
      Effect.mapError((error) =>
        error._tag === "MachinePeerError" || error._tag === "OrchestratorMcpFailure"
          ? error
          : new MachinePeerError({
              reason: "tool-failed",
              detail: `${input.tool} on ${resolved.peer.name} failed: ${error.message.slice(0, 500)}`,
            }),
      ),
    );
  });

  const callTool: MachinePeers["Service"]["callTool"] = Effect.fn("MachinePeers.callTool")(
    function* (input) {
      yield* requireMachineToolCaller();
      if (input.tool === "machine_exec") {
        // The exec arrow check and the History entry of MM-1908 live in `exec`.
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Use machine_exec to run commands on another machine.",
        });
      }
      const resolved = yield* resolvePeer(input.machine);
      yield* requireAgentTools(resolved);
      return yield* callPeer({
        resolved,
        kind: "full",
        check: requireMachineToolCaller(),
        tool: input.tool,
        input: input.input,
      });
    },
  );

  const environmentIdOf = Effect.fn("MachinePeers.environmentIdOf")(function* (
    peer: { readonly machine: PeerMachine; readonly origin: string },
    token: MachineMapState.MachineToken,
  ) {
    const descriptor = yield* HttpClientRequest.get(
      `${peer.origin}/.well-known/t3/environment`,
    ).pipe(
      HttpClientRequest.setHeaders(MachineMapState.tokenHeaders(token)),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.timeout(DESCRIPTOR_TIMEOUT),
    );
    environmentIds.set(peer.machine.id, descriptor.environmentId);
    return descriptor.environmentId;
  });

  /** The peers that an arrow with agent tools reaches now, with their environment ids. */
  const probeReadable = Effect.fn("MachinePeers.probeReadable")(function* (refresh: boolean) {
    const local = yield* state.snapshot;
    const desired = local.enabled ? local.saved.desired : null;
    if (desired === null || local.token === null) return [];
    const token = local.token;
    const nowMs = yield* Clock.currentTimeMillis;
    const peers = reachablePeers(desired, nowMs).filter((peer) => peer.agentTools);
    return yield* Effect.forEach(
      peers,
      (peer) => {
        const { machine } = peer;
        const cached = environmentIds.get(machine.id);
        const environmentId =
          cached !== undefined && !refresh ? Effect.succeed(cached) : environmentIdOf(peer, token);
        return environmentId.pipe(
          Effect.map((id): ReadonlyArray<ReadableEnvironment> => [
            { environmentId: id, machineId: machine.id, name: machine.name },
          ]),
          Effect.orElseSucceed((): ReadonlyArray<ReadableEnvironment> => []),
        );
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.map((lists) => lists.flat()));
  });

  const readThread: MachinePeers["Service"]["readThread"] = Effect.fn("MachinePeers.readThread")(
    function* ({ environmentId, ...input }) {
      yield* requireMachineThreadReader();
      const find = (readable: ReadonlyArray<ReadableEnvironment>) =>
        readable.find((candidate) => candidate.environmentId === environmentId);
      const target = find(yield* probeReadable(false)) ?? find(yield* probeReadable(true));
      if (target === undefined) {
        return yield* new MachinePeerError({
          reason: "unknown-environment",
          detail: `No arrow with agent tools from this machine reaches environment ${environmentId}, or its machine is offline. The owner can add the arrow in the machine map.`,
        });
      }
      const resolved = yield* resolvePeer(target.machineId);
      yield* requireAgentTools(resolved);
      const raw = yield* callPeer({
        resolved,
        kind: "read",
        check: requireMachineThreadReader(),
        tool: "t3_thread_read",
        // The peer reads its own thread, so it gets no environment id.
        input,
      });
      return yield* decodePeerResult(
        raw,
        OrchestratorMcpThreadReadResult,
        "t3_thread_read",
        resolved.peer.name,
      );
    },
  );

  const exec: MachinePeers["Service"]["exec"] = Effect.fn("MachinePeers.exec")(function* (input) {
    yield* requireMachineToolCaller();
    const resolved = yield* resolvePeer(input.machine);
    const nowMs = yield* Clock.currentTimeMillis;
    if (resolved.arrow === undefined || !arrowAllowsExec(resolved.arrow, nowMs)) {
      return yield* new MachinePeerError({
        reason: "no-exec",
        detail: `The arrow from this machine to ${resolved.peer.name} does not allow exec. It needs exec, agent tools and the level standard or admin. The owner can turn exec on in the machine map.`,
      });
    }
    // MM-806: the portal names the calling thread. An agent cannot set it through this path.
    const caller = yield* historyCaller();
    const { caller: _ignored, ...command } = input;
    const raw = yield* callPeer({
      resolved,
      kind: "full",
      check: requireMachineToolCaller(),
      tool: "machine_exec",
      input: {
        ...command,
        machine: resolved.peer.id,
        caller,
      },
    });
    return yield* decodePeerResult(raw, MachineExecResult, "machine_exec", resolved.peer.name);
  });

  const readableEnvironments: MachinePeers["Service"]["readableEnvironments"] = probeReadable(
    false,
  ).pipe(Effect.withSpan("MachinePeers.readableEnvironments"));

  const postJson: MachinePeers["Service"]["postJson"] = Effect.fn("MachinePeers.postJson")(
    function* (input) {
      const resolved = yield* resolvePeer(input.machine);
      const nowMs = yield* Clock.currentTimeMillis;
      if (resolved.arrow === undefined || effectiveLevel(resolved.arrow, nowMs) === "none") {
        return yield* new MachinePeerError({
          reason: "no-arrow",
          detail: `No arrow from this machine reaches ${resolved.peer.name}.`,
        });
      }
      const headers = MachineMapState.tokenHeaders(resolved.token);
      const post = (session: PeerSession) =>
        HttpClientRequest.post(`${peerOrigin(resolved.peer)}${input.path}`).pipe(
          HttpClientRequest.setHeaders({
            ...headers,
            authorization: `Bearer ${session.accessToken}`,
          }),
          HttpClientRequest.bodyText(input.body, "application/json"),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.timeout(REQUEST_TIMEOUT),
        );
      const pairOrFail = pair(resolved.peer, resolved.token, resolved.selfName, "full").pipe(
        Effect.mapError(
          (cause) =>
            new MachinePeerError({
              reason: "pairing-refused",
              detail: `${resolved.peer.name} refused the pairing: ${describe(cause)}.`,
            }),
        ),
      );
      const key = `${resolved.peer.id}:full` as const;
      const cached = sessions.get(key);
      const first = cached ?? (yield* pairOrFail);
      yield* post(first).pipe(
        // A level change on the peer revokes the session (MM-1306). Pair again once.
        Effect.catch((cause) =>
          cached !== undefined && describe(cause) === "HTTP 401"
            ? Effect.sync(() => sessions.delete(key)).pipe(
                Effect.andThen(pairOrFail),
                Effect.flatMap(post),
              )
            : Effect.fail(cause),
        ),
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, "MachinePeerError")
            ? (cause as MachinePeerError)
            : new MachinePeerError({
                reason: "unreachable",
                detail: `${resolved.peer.name} did not take the request: ${describe(cause)}.`,
              }),
        ),
      );
    },
  );

  return MachinePeers.of({ testArrow, callTool, postJson, readThread, exec, readableEnvironments });
});

export const layer = Layer.effect(MachinePeers, make);
