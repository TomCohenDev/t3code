import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { withThreadCredential } from "@t3tools/provider-core/server/forkThreadCredential";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";
import { GlobalFlag } from "effect/cli";

import { McpToolkits } from "../mcp/toolkits/registry.ts";
import { applyCallerThread, callOnServer, findMcpTool } from "./tool.ts";

const registryToolNames = () =>
  Object.values(McpToolkits)
    .flatMap((toolkit) => Object.values(toolkit.tools).map((tool) => tool.name))
    .toSorted();

it.effect("describes every registry tool with its MCP input schema", () =>
  Effect.gen(function* () {
    for (const toolkit of Object.values(McpToolkits)) {
      for (const tool of Object.values(toolkit.tools)) {
        const entry = yield* findMcpTool(tool.name);
        expect(entry.inputSchema).toEqual(Tool.getJsonSchema(tool));
      }
    }
    expect(registryToolNames()).toContain("t3_thread_organize");
  }),
);

it.effect("rejects a tool that is not in the registry", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(findMcpTool("not_a_tool"));
    expect(error.message).toContain("t3 tool list");
  }),
);

it.effect("requires a thread for thread-bound tools without a thread credential", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const error = yield* Effect.flip(
      applyCallerThread({
        tool,
        arguments: { action: "pin" },
        thread: Option.none(),
        hasThreadCredential: false,
      }),
    );
    expect(error.message).toContain("--thread");
  }),
);

it.effect("fills the thread from --thread and keeps an explicit threadId", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const filled = yield* applyCallerThread({
      tool,
      arguments: { action: "pin" },
      thread: Option.some("thread-a"),
      hasThreadCredential: false,
    });
    expect(filled.threadId).toBe("thread-a");
    const explicit = yield* applyCallerThread({
      tool,
      arguments: { action: "pin", threadId: "thread-b" },
      thread: Option.some("thread-a"),
      hasThreadCredential: false,
    });
    expect(explicit.threadId).toBe("thread-b");
  }),
);

it.effect("lets a thread credential omit the thread", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const result = yield* applyCallerThread({
      tool,
      arguments: { action: "pin" },
      thread: Option.none(),
      hasThreadCredential: true,
    });
    expect(result.threadId).toBeUndefined();
  }),
);

it.effect("an agent shell calls as its thread, not with the full-access fallback (MM-1920)", () =>
  Effect.gen(function* () {
    // A T3 home with no running server, so the full-access fallback would fail here.
    const baseDir = Option.some(yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped());
    const record = (env: NodeJS.ProcessEnv) => {
      const connections: Array<unknown> = [];
      return callOnServer({ baseDir }, (connection) =>
        Effect.sync(() => void connections.push(connection)),
      ).pipe(
        Effect.as(connections),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        Effect.provideService(GlobalFlag.LogLevel, Option.none()),
      );
    };
    const shell = withThreadCredential(
      {},
      { endpoint: "http://127.0.0.1:43123/mcp", authorizationHeader: "Bearer thread-a" },
    );
    expect(yield* record(shell)).toEqual([
      {
        endpoint: "http://127.0.0.1:43123/mcp",
        authorization: "Bearer thread-a",
        hasThreadCredential: true,
      },
    ]);
    const fallback = yield* Effect.flip(record({}));
    expect(fallback.message).toContain("server is not running");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);
