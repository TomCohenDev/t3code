import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunAttemptId,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

export class WorktreeResumeError extends Schema.TaggedError<WorktreeResumeError>()(
  "WorktreeResumeError",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. ${this.reason}`;
  }
}

export class ForkWorktreeResume extends Context.Service<
  ForkWorktreeResume,
  {
    readonly prepare: (input: {
      readonly thread: OrchestrationV2AppThread;
      readonly run: OrchestrationV2Run;
      readonly attemptId: RunAttemptId;
      readonly providerThreadId: ProviderThreadId;
      readonly ordinal: number;
    }) => Effect.Effect<void, WorktreeResumeError>;
  }
>()("t3/fork/ForkWorktreeResume") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const git = yield* Git.GitVcsDriver;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;

  const prepare: ForkWorktreeResume["Service"]["prepare"] = (input) =>
    Effect.gen(function* () {
      if (!(yield* settings.getSettings).restoreWorktreesOnResume) return;
      const { thread, run } = input;
      const cwd = thread.worktreePath;
      if (cwd === null) return;
      const fail = (reason: string) => new WorktreeResumeError({ cwd, reason });
      if (!path.isAbsolute(cwd) || thread.branch === null)
        return yield* fail("The saved worktree path or branch is missing.");
      const project = yield* projects.getById(thread.projectId);
      if (Option.isNone(project)) return yield* fail("The project repository is missing.");
      const repository = project.value.workspaceRoot;
      const exec = (args: readonly string[], location = repository) =>
        git.execute({ cwd: location, args, operation: "restore worktree" });
      const common = yield* exec(["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
        Effect.mapError(
          (cause) =>
            new WorktreeResumeError({
              cwd,
              reason: "The project repository is missing or cannot be read.",
              cause,
            }),
        ),
      );
      // readLink also sees dangling links. Never replace an occupied path or follow a worktree link.
      const link = yield* fs.readLink(cwd).pipe(Effect.option);
      if (Option.isSome(link))
        return yield* fail("The saved path is a symbolic link; it was left untouched.");
      const exists = yield* fs.exists(cwd);
      const needsSetup =
        !exists ||
        ((yield* fs.exists(path.join(cwd, "package.json"))) &&
          !(yield* fs.exists(path.join(cwd, "node_modules"))));
      const branch = yield* exec(["show-ref", "--verify", `refs/heads/${thread.branch}`]).pipe(
        Effect.result,
      );
      if (branch._tag === "Failure")
        return yield* fail("The saved local branch does not exist; no branch was created.");
      if (exists) {
        const [actualCommon, actualBranch, top] = yield* Effect.all([
          exec(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
          exec(["symbolic-ref", "HEAD"], cwd),
          exec(["rev-parse", "--show-toplevel"], cwd),
        ]);
        const [expectedCommon, worktreeCommon, worktreeRoot, savedRoot] = yield* Effect.all([
          fs.realPath(common.stdout.trim()),
          fs.realPath(actualCommon.stdout.trim()),
          fs.realPath(top.stdout.trim()),
          fs.realPath(cwd),
        ]);
        if (
          expectedCommon !== worktreeCommon ||
          actualBranch.stdout.trim() !== `refs/heads/${thread.branch}` ||
          worktreeRoot !== savedRoot
        ) {
          return yield* fail("The saved path is not the expected worktree; it was left untouched.");
        }
      } else {
        yield* exec(["worktree", "prune"]);
        // Exact local ref checked above; no -b, -B, reset, force or branch movement.
        yield* exec(["worktree", "add", "--no-guess-remote", "--", cwd, thread.branch]);
      }
      if (!needsSetup) return;
      const startedAt = yield* DateTime.now;
      const activity = (status: "running" | "completed" | "failed", output: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const item: OrchestrationV2TurnItem = {
            id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "fork-worktree-restore" }),
            threadId: thread.id,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: input.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal,
            type: "command_execution",
            status,
            title: exists ? "Restoring worktree dependencies" : "Restored missing worktree",
            input: "Project setup",
            output,
            ...(status === "running" ? {} : { exitCode: status === "completed" ? 0 : 1 }),
            startedAt,
            completedAt: status === "running" ? null : now,
            updatedAt: now,
          };
          yield* sink.writeIfRunCurrent({
            threadId: thread.id,
            runId: run.id,
            activeAttemptId: input.attemptId,
            expectedStatus: "starting",
            events: [
              {
                id: yield* ids.allocate.event({ threadId: thread.id }),
                threadId: thread.id,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                type: "turn-item.updated",
                payload: item,
              },
            ],
          });
        });
      yield* activity("running", "Running project setup before the agent starts.");
      yield* Effect.gen(function* () {
        const result = yield* setup.runForThread({
          threadId: thread.id,
          projectId: thread.projectId,
          projectCwd: repository,
          worktreePath: cwd,
          observeCompletion: {},
          project: project.value,
        });
        if (result.status === "started" && result.completion) {
          const completed = yield* result.completion;
          if (completed.exitCode !== 0)
            return yield* fail(
              "Project setup did not succeed. The checkout and branch were kept; retry setup before continuing.",
            );
        }
        yield* activity(
          "completed",
          result.status === "no-script"
            ? "No project setup script is configured."
            : "Project setup finished.",
        );
      }).pipe(
        Effect.tapError(() =>
          activity("failed", "Project setup failed. The checkout and branch were kept."),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(WorktreeResumeError)(cause)
          ? cause
          : new WorktreeResumeError({
              cwd: input.thread.worktreePath ?? "",
              reason:
                "The worktree could not be prepared. Its branch and any existing files were left untouched.",
              cause,
            }),
      ),
    );
  return ForkWorktreeResume.of({ prepare });
});

export const layer = Layer.effect(ForkWorktreeResume, make);

// The core orchestration layer also runs without fork extensions (replay and upstream tests).
// Production installs this service at the same boundary as the project setup runner.
export const makePrepare = Effect.serviceOption(ForkWorktreeResume).pipe(
  Effect.map(
    Option.match({
      onNone: () => (_input: Parameters<ForkWorktreeResume["Service"]["prepare"]>[0]) =>
        Effect.void,
      onSome: (service) => service.prepare,
    }),
  ),
);
