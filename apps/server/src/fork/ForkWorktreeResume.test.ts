import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  ProjectId,
  RunId,
  NodeId,
  RunAttemptId,
  ProviderThreadId,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Config from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Resume from "./ForkWorktreeResume.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

const layerGit = Git.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "fork-worktree-resume-" })),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped();
  const repository = path.join(root, "repo");
  const cwd = path.join(root, "checkout");
  yield* fs.makeDirectory(repository);
  const exec = (args: readonly string[], location = repository) =>
    git.execute({ cwd: location, args, operation: "test worktree resume" });
  yield* exec(["init", "-b", "main"]);
  yield* exec(["config", "user.name", "Test"]);
  yield* exec(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(repository, "package.json"), "{}");
  yield* exec(["add", "package.json"]);
  yield* exec(["commit", "-m", "initial"]);
  yield* exec(["branch", "saved"]);
  const input = {
    thread: {
      id: ThreadId.make("resume-thread"),
      projectId: ProjectId.make("resume-project"),
      worktreePath: cwd,
      branch: "saved",
    } as OrchestrationV2AppThread,
    run: {
      id: RunId.make("resume-run"),
      rootNodeId: NodeId.make("resume-node"),
      providerInstanceId: ProviderInstanceId.make("resume-provider"),
    } as OrchestrationV2Run,
    attemptId: RunAttemptId.make("resume-attempt"),
    providerThreadId: ProviderThreadId.make("resume-provider-thread"),
    turnItems: [],
  };
  const activities: unknown[] = [];
  let setups = 0;
  const layer = (enabled = true, exitCode = 0, trackerLayer = Tracker.layer) =>
    Resume.layer.pipe(
      Layer.provide(trackerLayer),
      Layer.provide(
        Layer.mergeAll(
          Settings.layerTest({ restoreWorktreesOnResume: enabled }),
          IdAllocator.layer,
          Layer.mock(Projects.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: input.thread.projectId,
                  workspaceRoot: repository,
                  scripts: [],
                } as never),
              ),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (request) =>
              Effect.sync(() => {
                activities.push(...request.events);
                return { committed: true, storedEvents: [] } as never;
              }),
          }),
          Layer.mock(Setup.ProjectSetupScriptRunner)({
            runForThread: (request) =>
              Effect.gen(function* () {
                setups++;
                assert.strictEqual(request.worktreePath, cwd);
                assert.isTrue(yield* fs.exists(path.join(cwd, "package.json")).pipe(Effect.orDie));
                return {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "install",
                  terminalId: "setup",
                  cwd,
                  async: false,
                  completion: Effect.gen(function* () {
                    if (exitCode === 0)
                      yield* fs
                        .makeDirectory(path.join(cwd, "node_modules"), { recursive: true })
                        .pipe(Effect.orDie);
                    return { exitCode, durationMs: 1 };
                  }),
                };
              }),
          }),
        ),
      ),
    );
  const prepare = (enabled = true, exitCode = 0, trackerLayer = Tracker.layer) =>
    Effect.gen(function* () {
      yield* (yield* Resume.ForkWorktreeResume).prepare(input);
    }).pipe(Effect.provide(layer(enabled, exitCode, trackerLayer)));
  return { fs, path, exec, cwd, repository, input, activities, prepare, setups: () => setups };
});

it.effect("restores the same branch and path, waits for setup, and publishes activity", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.exec(["rev-parse", "saved"]);
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    yield* f.fs.remove(f.cwd, { recursive: true });
    yield* f.prepare();
    assert.strictEqual((yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout, before.stdout);
    assert.strictEqual(
      (yield* f.exec(["symbolic-ref", "--short", "HEAD"], f.cwd)).stdout.trim(),
      "saved",
    );
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
    assert.strictEqual(f.setups(), 1);
    assert.lengthOf(f.activities, 2);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("runs setup for missing dependencies without changing dirty files or HEAD", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    yield* f.fs.writeFileString(f.path.join(f.cwd, "package.json"), "dirty");
    yield* f.prepare();
    yield* f.prepare();
    assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, "package.json")), "dirty");
    assert.strictEqual(f.setups(), 1);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("does nothing while off", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.prepare(false);
    assert.isFalse(yield* f.fs.exists(f.cwd));
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("restores evicted dependencies even when the restore setting is off", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    const marker = yield* (yield* makeSetupMarker)(f.cwd);
    yield* marker.mark;
    yield* f.prepare(false);
    assert.strictEqual(f.setups(), 1);
    assert.isFalse(yield* marker.pending);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("waits for the launcher's existing async setup instead of starting another", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    const waiting = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    const trackerLayer = Layer.mock(Tracker.WorktreeSetupTracker)({
      get: () =>
        Effect.succeed({
          phase: "running",
          stages: [{ id: "setup-script", status: "running" }],
        } as never),
      stream: () =>
        Stream.fromEffect(
          Deferred.succeed(waiting, undefined).pipe(
            Effect.andThen(Deferred.await(complete)),
            Effect.as(null),
          ),
        ),
    });
    const startup = yield* f
      .prepare(true, 0, trackerLayer)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(waiting);
    assert.strictEqual(f.setups(), 0);
    yield* f.fs.makeDirectory(f.path.join(f.cwd, "node_modules"));
    yield* Deferred.succeed(complete, undefined);
    yield* Fiber.join(startup);
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("never recreates a missing branch", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["branch", "-D", "saved"]);
    const error = yield* f.prepare().pipe(Effect.flip);
    assert.include(error.message, "local branch does not exist");
    assert.isFalse(yield* f.fs.exists(f.cwd));
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("leaves a conflicting path and symbolic link untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.makeDirectory(f.cwd);
    yield* f.fs.writeFileString(f.path.join(f.cwd, "private"), "keep");
    yield* f.prepare().pipe(Effect.flip);
    assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, "private")), "keep");
    yield* f.fs.remove(f.cwd, { recursive: true });
    yield* f.fs.symlink(f.repository, f.cwd);
    const error = yield* f.prepare().pipe(Effect.flip);
    assert.include(error.message, "symbolic link");
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("fails before starting the agent when setup fails, preserving the checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const error = yield* f.prepare(true, 1).pipe(Effect.flip);
    assert.include(error.message, "setup did not succeed");
    assert.isTrue(yield* f.fs.exists(f.cwd));
    yield* f.prepare();
    assert.strictEqual(f.setups(), 2);
  }).pipe(Effect.provide(layerGit)),
);
