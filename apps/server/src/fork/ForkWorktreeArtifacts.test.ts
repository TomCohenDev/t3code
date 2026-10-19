import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type StorageCleanupReportEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "../storageCleanup.ts";
import * as Artifacts from "./ForkWorktreeArtifacts.ts";
import * as Processes from "./ForkProcessCwds.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";

const layerGit = Git.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "fork-worktree-artifacts-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped();
  const repo = path.join(root, "repo");
  const cwd = path.join(root, "checkout");
  yield* fs.makeDirectory(repo);
  const exec = (args: readonly string[], location = repo) =>
    git.execute({ cwd: location, args, operation: "artifact test" });
  yield* exec(["init", "-b", "main"]);
  yield* exec(["config", "user.name", "Test"]);
  yield* exec(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(
    path.join(repo, ".gitignore"),
    "node_modules\nbuild\n.env\nunknown\nignored.txt\n.turbo\n.gradle\n.cxx\napps/mobile/android\napps/*/dist\ndist-electron\nrelease/\nrelease-mock/\n",
  );
  yield* fs.writeFileString(path.join(repo, "source.ts"), "original");
  yield* exec(["add", "."]);
  yield* exec(["commit", "-m", "initial"]);
  yield* exec(["worktree", "add", "-b", "saved", cwd]);
  const file = (relative: string, content = "artifact") =>
    fs
      .makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(cwd, relative), content)));
  let cwds: readonly string[] | null = [];
  const layer = Artifacts.layer.pipe(
    Layer.provide(Layer.succeed(Processes.ForkProcessCwds, { read: Effect.sync(() => cwds) })),
  );
  const evict = (reason: string | null = null) =>
    Effect.gen(function* () {
      return yield* (yield* Artifacts.ForkWorktreeArtifacts).evict({
        cwd,
        blocked: Effect.succeed(reason),
      });
    }).pipe(Effect.provide(layer));
  return {
    fs,
    path,
    root,
    repo,
    cwd,
    file,
    exec,
    evict,
    layer,
    processes: (value: readonly string[] | null) => {
      cwds = value;
    },
  };
});

it.effect(
  "removes only ignored, untracked allowlisted directories, preserving all code state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("node_modules/pkg/data", "12345");
      yield* f.file("apps/web/node_modules/pkg/data", "abc");
      yield* f.file(".env", "secret");
      yield* f.file("unknown/data", "keep ignored data");
      yield* f.file("ignored.txt", "keep ignored file");
      yield* f.file("source.ts", "dirty source");
      const head = (yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout;
      const before = (yield* f.exec(["status", "--porcelain=v1", "-z"], f.cwd)).stdout;
      const result = yield* f.evict();
      assert.strictEqual(result.directories, 2);
      assert.strictEqual(result.bytes, 8);
      assert.deepStrictEqual(result.artifactBreakdown, [
        { folderType: "node_modules", logicalBytes: 8, folders: 2 },
      ]);
      assert.include(result.reason, "Artifacts removed");
      assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
      assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, ".env")), "secret");
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "unknown/data")),
        "keep ignored data",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "ignored.txt")),
        "keep ignored file",
      );
      assert.strictEqual(
        (yield* f.exec(["symbolic-ref", "--short", "HEAD"], f.cwd)).stdout.trim(),
        "saved",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "source.ts")),
        "dirty source",
      );
      assert.strictEqual((yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout, head);
      assert.strictEqual((yield* f.exec(["status", "--porcelain=v1", "-z"], f.cwd)).stdout, before);
      const marker = yield* (yield* makeSetupMarker)(f.cwd);
      assert.isTrue(yield* marker.pending);
    }).pipe(Effect.provide(layerGit)),
);

it.effect("keeps tracked files, non-ignored directories and protected nested files", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/tracked", "tracked");
    yield* f.exec(["add", "-f", "node_modules/tracked"], f.cwd);
    yield* f.file(".vite/output", "not ignored");
    yield* f.file("build/.env", "secret");
    yield* f.file("build/output", "generated");
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/tracked")));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, ".vite/output")));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "build/.env")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("never follows symbolic links outside the checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const outside = f.path.join(f.root, "outside");
    yield* f.fs.makeDirectory(outside);
    yield* f.fs.writeFileString(f.path.join(outside, "keep"), "private");
    yield* f.fs.symlink(outside, f.path.join(f.cwd, "node_modules"));
    yield* f.file(".turbo/cache", "generated");
    yield* f.fs.symlink(outside, f.path.join(f.cwd, ".turbo/link"));
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 1);
    assert.strictEqual(yield* f.fs.readFileString(f.path.join(outside, "keep")), "private");
    assert.strictEqual(yield* f.fs.readLink(f.path.join(f.cwd, "node_modules")), outside);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("keeps artifacts when busy or when process inspection is incomplete", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/file");
    f.processes([f.path.join(f.cwd, "node_modules")]);
    assert.strictEqual((yield* f.evict()).directories, 0);
    f.processes(null);
    assert.include((yield* f.evict()).reason, "could not be inspected");
    f.processes([]);
    assert.strictEqual((yield* f.evict("open terminal")).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/file")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("checks ownership again after scanning and before deletion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/file");
    let reads = 0;
    const result = yield* Effect.gen(function* () {
      return yield* (yield* Artifacts.ForkWorktreeArtifacts).evict({
        cwd: f.cwd,
        blocked: Effect.sync(() => (++reads > 1 ? "a turn was queued" : null)),
      });
    }).pipe(Effect.provide(f.layer));
    assert.strictEqual(result.directories, 0);
    assert.include(result.reason, "turn was queued");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/file")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("limits Gradle removal to known mobile artifact paths", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("apps/mobile/android/.gradle/cache");
    yield* f.file("apps/mobile/android/app/build/output");
    yield* f.file("apps/mobile/android/app/src/keep.java", "source");
    yield* f.file("apps/mobile/modules/t3-terminal/android/build/output");
    yield* f.file("apps/mobile/modules/t3-terminal/android/.gradle/cache");
    yield* f.file("apps/mobile/modules/t3-terminal/android/.cxx/output");
    yield* f.file("apps/mobile/modules/t3-terminal/android/src/build/source.java", "source");
    yield* f.file(".gradle/keep", "not mobile");
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 5);
    assert.deepStrictEqual(result.artifactBreakdown, [
      { folderType: "android-build", logicalBytes: 24, folders: 3 },
      { folderType: "gradle-cache", logicalBytes: 16, folders: 2 },
    ]);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/src/keep.java")));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, ".gradle/keep")));
    assert.isTrue(
      yield* f.fs.exists(
        f.path.join(f.cwd, "apps/mobile/modules/t3-terminal/android/src/build/source.java"),
      ),
    );
  }).pipe(Effect.provide(layerGit)),
);

it.effect(
  "removes build outputs before node_modules and reports logical bytes per folder type",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("node_modules/package/data", "nodes");
      yield* f.file("apps/mobile/android/app/build/output", "android");
      yield* f.file("apps/mobile/modules/t3-terminal/android/.gradle/cache", "abc");
      yield* f.file("apps/web/dist/output", "js");
      yield* f.file(".turbo/cache", "x");
      let reads = 0;
      const first = yield* Effect.gen(function* () {
        return yield* (yield* Artifacts.ForkWorktreeArtifacts).evict({
          cwd: f.cwd,
          blocked: Effect.sync(() => (++reads > 2 ? "a turn was queued" : null)),
        });
      }).pipe(Effect.provide(f.layer));
      assert.deepStrictEqual(first.artifactBreakdown, [
        { folderType: "android-build", logicalBytes: 7, folders: 1 },
      ]);
      assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build")));
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/package/data")));
      const remaining = yield* f.evict();
      assert.deepStrictEqual(remaining.artifactBreakdown, [
        { folderType: "gradle-cache", logicalBytes: 3, folders: 1 },
        { folderType: "build-output", logicalBytes: 2, folders: 1 },
        { folderType: "cache", logicalBytes: 1, folders: 1 },
        { folderType: "node_modules", logicalBytes: 5, folders: 1 },
      ]);
    }).pipe(Effect.provide(layerGit)),
);

it.effect(
  "recognizes ignored Electron and release build outputs without widening the allowlist",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("apps/desktop/dist-electron/entry.js", "js");
      yield* f.file("release/installer.zip", "zip");
      yield* f.file("release-mock/installer.zip", "mock");
      yield* f.file("unknown/installer.zip", "keep");
      const result = yield* f.evict();
      assert.deepStrictEqual(result.artifactBreakdown, [
        { folderType: "build-output", logicalBytes: 9, folders: 3 },
      ]);
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "unknown/installer.zip")));
    }).pipe(Effect.provide(layerGit)),
);

const now = Date.parse("2026-10-19T00:00:00Z");
it.effect(
  "sweep enforces off, settled/inactive, shared, terminal, running and pending-work guards",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("node_modules/file");
      const base = {
        id: ThreadId.make("artifact-thread"),
        title: "Test",
        projectId: ProjectId.make("artifact-project"),
        branch: "saved",
        worktreePath: f.cwd,
        activeRunId: null,
        status: "idle",
        pendingBackgroundTasks: [],
        pendingRuntimeRequest: null,
        pendingUserInput: null,
        queuedMessages: [],
        settledAt: DateTime.makeUnsafe(now - 120_000),
        createdAt: DateTime.makeUnsafe(now - 30 * 86_400_000),
        latestUserMessageAt: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
      } as unknown as OrchestrationV2ThreadShell;
      let thread = base;
      let terminal = false;
      let pending = false;
      let shared = false;
      let sessionLive = false;
      let setupConfigured = true;
      let hasThread = true;
      let settings = { ...DEFAULT_SERVER_SETTINGS, worktreeArtifactEviction: false };
      const project = {
        id: base.projectId,
        projectId: base.projectId,
        workspaceRoot: f.repo,
        scripts: [{ id: "setup", name: "Setup", command: "install", runOnWorktreeCreate: true }],
      };
      const sql = ((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("effect_outbox")) return Effect.succeed(pending ? [{}] : []);
        if (query.includes("projection_provider_sessions"))
          return Effect.succeed(sessionLive ? [{ id: "session", cwd: f.cwd }] : []);
        if (!hasThread) return Effect.succeed([]);
        return Effect.succeed([
          { threadId: base.id, worktreePath: f.cwd },
          ...(shared ? [{ threadId: "second", worktreePath: `${f.cwd}/.` }] : []),
        ]);
      }) as unknown as SqlClient.SqlClient;
      const sweep = yield* Artifacts.makeSweep({
        hasTerminal: () => terminal,
        idle: storageCleanupThreadIdle,
        activityAt: storageCleanupActivityAt,
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Projections.ProjectionStoreV2, {
          getThreadShell: () => Effect.sync(() => thread),
        } as unknown as Projections.ProjectionStoreV2["Service"]),
        Effect.provideService(Projects.ProjectStoreV2, {
          listShells: () => Effect.succeed([project]),
          get: () =>
            Effect.succeed(
              Option.some({ ...project, scripts: setupConfigured ? project.scripts : [] }),
            ),
        } as unknown as Projects.ProjectStoreV2["Service"]),
        Effect.provideService(Settings.ServerSettingsService, {
          getSettings: Effect.sync(() => settings),
        } as unknown as Settings.ServerSettingsService["Service"]),
        Effect.provideService(Sessions.ProviderSessionManagerV2, {
          isLive: () => Effect.sync(() => sessionLive),
        } as unknown as Sessions.ProviderSessionManagerV2["Service"]),
      );
      const run = (existing: StorageCleanupReportEntry[] = []) =>
        Effect.gen(function* () {
          const entries: StorageCleanupReportEntry[] = [...existing];
          yield* sweep(settings, now, entries);
          return entries;
        });
      assert.lengthOf(yield* run(), 0);
      settings = { ...settings, worktreeArtifactEviction: true };
      hasThread = false;
      yield* f.file("apps/mobile/android/app/build/output");
      assert.lengthOf(yield* run(), 0);
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/file")));
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build/output")));
      hasThread = true;
      terminal = true;
      assert.include((yield* run())[0]!.reason, "open terminal");
      terminal = false;
      shared = true;
      assert.include((yield* run())[0]!.reason, "shared by 2");
      shared = false;
      pending = true;
      assert.include((yield* run())[0]!.reason, "pending work");
      pending = false;
      sessionLive = true;
      assert.include((yield* run())[0]!.reason, "provider session");
      sessionLive = false;
      setupConfigured = false;
      assert.include((yield* run())[0]!.reason, "no project setup");
      setupConfigured = true;
      thread = { ...base, status: "running" };
      assert.include((yield* run())[0]!.reason, "running");
      thread = {
        ...base,
        latestRunId: null,
        latestUserMessageAt: DateTime.makeUnsafe(now - 1_000),
      };
      assert.include((yield* run())[0]!.reason, "queued");
      thread = { ...base, settledAt: DateTime.makeUnsafe(now - 1_000) };
      assert.include((yield* run())[0]!.reason, "settled moments ago");
      thread = {
        ...base,
        settledAt: null,
        latestUserMessageAt: DateTime.makeUnsafe(now - 86_400_000),
      };
      assert.include((yield* run())[0]!.reason, "less than 14");
      thread = base;
      const entries = yield* run([
        {
          kind: "worktree",
          outcome: "kept",
          reason: "No whole-worktree rules apply",
          path: f.cwd,
          threadId: base.id,
          threadTitle: base.title,
          bytes: null,
          files: null,
        },
      ]);
      assert.lengthOf(entries, 1);
      assert.include(entries[0]!.reason, "Artifacts removed");
      assert.deepStrictEqual(entries[0]!.artifactBreakdown, [
        { folderType: "android-build", logicalBytes: 8, folders: 1 },
        { folderType: "node_modules", logicalBytes: 8, folders: 1 },
      ]);
      assert.isTrue(yield* f.fs.exists(f.cwd));
    }).pipe(Effect.provide(layerGit)),
);
