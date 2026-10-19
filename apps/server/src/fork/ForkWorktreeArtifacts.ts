import type {
  OrchestrationV2ThreadShell,
  ServerSettings,
  StorageCleanupReportEntry,
  ForkArtifactFolderType,
  ForkArtifactBreakdown,
} from "@t3tools/contracts";
import { FORK_ARTIFACT_FOLDER_TYPES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as Processes from "./ForkProcessCwds.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Config from "../config.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";

const DAY_MS = 86_400_000;
export const sameSettings = (left: ServerSettings, right: ServerSettings) =>
  left.worktreeArtifactEviction === right.worktreeArtifactEviction &&
  left.worktreeArtifactEvictionDays === right.worktreeArtifactEvictionDays;
const protectedName = (name: string) => {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".env") ||
    /\.(?:pem|key|p12|p8|jks|mobileprovision)$/.test(lower) ||
    [
      ".git",
      "_shared",
      ".t3",
      "userdata",
      "secrets",
      ".secrets",
      ".aws",
      ".ssh",
      ".npmrc",
      ".pypirc",
      ".repos",
    ].includes(lower)
  );
};
const artifactFolderType = (relative: string) => {
  const android =
    /^apps\/mobile\/(?:android(?:\/app)?|modules\/[^/]+\/android)\/(build|\.gradle|\.cxx)$/.exec(
      relative,
    );
  if (android)
    return android[1] === ".gradle" ? ("gradle-cache" as const) : ("android-build" as const);
  if (relative === "apps/mobile/.gradle") return "gradle-cache" as const;
  // Output locations in .gitignore and build scripts, not arbitrary ignored folders.
  if (
    /^(?:apps|packages|infra)\/[^/]+\/(?:dist|dist-exe|build)$/.test(relative) ||
    /^(?:build|dist-electron|release|release-mock)$/.test(relative) ||
    relative === "apps/desktop/dist-electron" ||
    relative === "apps/mobile/web-build" ||
    /^native\/[^/]+\/target$/.test(relative)
  )
    return "build-output" as const;
  const name = relative.split("/").at(-1)!;
  if (name === "node_modules") return "node_modules" as const;
  if (
    [".turbo", ".vite"].includes(name) ||
    ["apps/mobile/.expo", "apps/marketing/.astro", "apps/web/.tanstack"].includes(relative) ||
    /^(?:(?:apps|packages|infra)\/[^/]+\/)?\.vite-plus$/.test(relative)
  )
    return "cache" as const;
  return null;
};

export class ForkWorktreeArtifacts extends Context.Service<
  ForkWorktreeArtifacts,
  {
    readonly evict: (input: {
      readonly cwd: string;
      readonly blocked: Effect.Effect<string | null>;
    }) => Effect.Effect<{
      readonly reason: string;
      readonly bytes: number;
      readonly directories: number;
      readonly failed: boolean;
      readonly artifactBreakdown: ForkArtifactBreakdown;
    }>;
  }
>()("t3/fork/ForkWorktreeArtifacts") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const processes = yield* Processes.ForkProcessCwds;
  const markerFor = yield* makeSetupMarker;
  const config = yield* Config.ServerConfig;
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const isLink = (target: string) =>
    fs.readLink(target).pipe(
      Effect.match({
        onSuccess: () => true,
        onFailure: (error) =>
          !(error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL"),
      }),
    );
  const evict: ForkWorktreeArtifacts["Service"]["evict"] = ({ cwd, blocked }) =>
    Effect.suspend(() => {
      let bytes = 0;
      let directories = 0;
      const breakdown = new Map<
        ForkArtifactFolderType,
        { folderType: ForkArtifactFolderType; logicalBytes: number; folders: number }
      >();
      const kept = (reason: string) => ({
        reason: directories > 0 ? `Artifacts removed; ${reason}` : reason,
        bytes,
        directories,
        failed: false,
        artifactBreakdown: [...breakdown.values()],
      });
      return Effect.gen(function* () {
        const root = yield* fs.realPath(cwd);
        if (yield* isLink(cwd)) return kept("Worktree is a symbolic link");
        if ((yield* fs.stat(path.join(root, ".git"))).type !== "File")
          return kept("Not a linked worktree");
        const top = yield* git.execute({
          cwd: root,
          args: ["rev-parse", "--show-toplevel"],
          operation: "inspect artifact checkout",
        });
        if ((yield* fs.realPath(top.stdout.trim())) !== root) return kept("Not the worktree root");
        const processBlock = Effect.gen(function* () {
          const cwds = yield* processes.read;
          if (cwds === null) return "Process working directories could not be inspected";
          for (const cwd of cwds) {
            const real = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
            if (inside(root, real)) return "A process has its working directory in this worktree";
          }
          return null;
        });
        const initiallyBlocked = (yield* blocked) ?? (yield* processBlock);
        if (initiallyBlocked !== null) return kept(initiallyBlocked);
        const pending = [root];
        const candidates: { path: string; folderType: ForkArtifactFolderType }[] = [];
        let inspected = 0;
        while (pending.length > 0) {
          const directory = pending.pop()!;
          if ((yield* fs.realPath(directory)) !== directory)
            return kept("Directory changed during inspection");
          for (const name of yield* fs.readDirectory(directory)) {
            if (++inspected > 2_000_000) return kept("Artifact inspection limit reached");
            if (protectedName(name)) continue;
            const target = path.join(directory, name);
            if (!inside(root, target) || (yield* isLink(target))) continue;
            if ((yield* fs.stat(target)).type !== "Directory") continue;
            const relative = path.relative(root, target).split(path.sep).join("/");
            const folderType = artifactFolderType(relative);
            if (folderType !== null) candidates.push({ path: target, folderType });
            else pending.push(target);
          }
        }
        const marker = yield* markerFor(cwd);
        let refused = 0;
        candidates.sort(
          (left, right) =>
            FORK_ARTIFACT_FOLDER_TYPES.indexOf(left.folderType) -
            FORK_ARTIFACT_FOLDER_TYPES.indexOf(right.folderType),
        );
        for (const { path: target, folderType } of candidates) {
          const data = yield* fs
            .realPath(config.stateDir)
            .pipe(Effect.orElseSucceed(() => path.resolve(config.stateDir)));
          if (inside(target, data) || inside(data, target)) {
            refused++;
            continue;
          }
          const relative = path.relative(root, target).split(path.sep).join("/");
          const check = () =>
            Effect.gen(function* () {
              if ((yield* fs.realPath(target)) !== target || (yield* isLink(target))) return false;
              const ignored = yield* git.execute({
                cwd: root,
                args: ["check-ignore", "--quiet", "--", `${relative}/`],
                allowNonZeroExit: true,
                operation: "check artifact ignore",
              });
              if (ignored.exitCode !== 0) return false;
              const tracked = yield* git.execute({
                cwd: root,
                args: ["ls-files", "-z", "--", `:(literal)${relative}/`],
                maxOutputBytes: 16 * 1024,
                operation: "check tracked artifact files",
              });
              return tracked.stdout === "" && !tracked.stdoutTruncated;
            });
          if (!(yield* check())) {
            refused++;
            continue;
          }
          let size = 0;
          let protectedContents = false;
          const contents = [target];
          while (contents.length > 0 && !protectedContents) {
            const entry = contents.pop()!;
            if (++inspected > 2_000_000) return kept("Artifact inspection limit reached");
            if (protectedName(path.basename(entry))) {
              protectedContents = true;
              break;
            }
            if (yield* isLink(entry)) continue;
            if ((yield* fs.realPath(entry)) !== entry) {
              protectedContents = true;
              break;
            }
            const stat = yield* fs.stat(entry);
            if (stat.type === "Directory")
              for (const name of yield* fs.readDirectory(entry))
                contents.push(path.join(entry, name));
            else if (stat.type === "File") size += Number(stat.size);
          }
          if (protectedContents) {
            refused++;
            continue;
          }
          const reason = (yield* blocked) ?? (yield* processBlock);
          if (reason !== null) return kept(reason);
          if (!(yield* check())) return kept("Git state changed during inspection");
          yield* marker.mark;
          // Native recursive removal unlinks descendant symlinks; it never traverses their targets.
          yield* fs.remove(target, { recursive: true }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                directories++;
                bytes += size;
                const previous = breakdown.get(folderType);
                breakdown.set(folderType, {
                  folderType,
                  logicalBytes: (previous?.logicalBytes ?? 0) + size,
                  folders: (previous?.folders ?? 0) + 1,
                });
              }),
            ),
            Effect.uninterruptible,
          );
        }
        return kept(
          directories > 0
            ? refused > 0
              ? `${refused} protected or non-ignored directories kept`
              : "checkout kept"
            : refused > 0
              ? "Artifact directories are tracked, not ignored, or contain protected files"
              : "No allowlisted artifacts",
        );
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catch(() =>
          Effect.succeed({
            ...kept("Artifact inspection or removal failed; checkout kept"),
            failed: true,
          }),
        ),
      );
    });
  return ForkWorktreeArtifacts.of({ evict });
});

export const layer = Layer.effect(ForkWorktreeArtifacts, make);
export const layerDefault = layer.pipe(
  Layer.provide(Processes.layer.pipe(Layer.provide(ProcessRunner.layer))),
);

export const makeSweep = (guards: {
  readonly hasTerminal: (cwd: string) => boolean;
  readonly idle: (thread: OrchestrationV2ThreadShell, now: number) => boolean;
  readonly activityAt: (thread: OrchestrationV2ThreadShell) => number;
}) =>
  Effect.gen(function* () {
    const artifacts = yield* ForkWorktreeArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* Projections.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const settingsService = yield* Settings.ServerSettingsService;
    const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
    const git = yield* Git.GitVcsDriver;
    const canonical = (cwd: string) =>
      fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    return (settings: ServerSettings, now: number, entries: StorageCleanupReportEntry[]) =>
      Effect.gen(function* () {
        if (!settings.worktreeArtifactEviction) return;
        const report = (entry: StorageCleanupReportEntry) => {
          const index = entries.findIndex(
            (existing) => existing.kind === "worktree" && existing.path === entry.path,
          );
          if (index < 0) {
            entries.push(entry);
            return;
          }
          const previous = entries[index]!;
          entries[index] = {
            ...entry,
            outcome:
              previous.outcome === "failed" || entry.outcome === "failed"
                ? "failed"
                : previous.outcome === "removed" || entry.outcome === "removed"
                  ? "removed"
                  : previous.outcome,
            reason: `${previous.reason}; ${entry.reason}`,
            bytes:
              previous.bytes === null && entry.bytes === null
                ? null
                : (previous.bytes ?? 0) + (entry.bytes ?? 0),
          };
        };
        const rows = yield* sql<{
          threadId: string;
          worktreePath: string;
        }>`SELECT thread_id AS "threadId", json_extract(payload_json, '$.worktreePath') AS "worktreePath" FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL`;
        const normalized = yield* Effect.forEach(rows, (row) =>
          canonical(row.worktreePath).pipe(Effect.map((key) => ({ ...row, key }))),
        );
        const groups = Map.groupBy(normalized, (row) => row.key);
        for (const [canonicalCwd, group] of groups) {
          const cwd = path.resolve(group[0]!.worktreePath);
          const thread = yield* projections.getThreadShell(
            group[0]!.threadId as OrchestrationV2ThreadShell["id"],
          );
          const entry: StorageCleanupReportEntry = {
            kind: "worktree",
            outcome: "kept",
            reason: "",
            path: cwd,
            threadId: thread?.id ?? null,
            threadTitle: thread?.title ?? null,
            bytes: null,
            files: null,
          };
          const keep = (reason: string) =>
            report({ ...entry, reason: `Artifacts kept: ${reason}` });
          if (group.length !== 1) {
            keep(`shared by ${group.length} threads`);
            continue;
          }
          if (thread === null) {
            keep("thread is unavailable");
            continue;
          }
          const blocked = Effect.gen(function* () {
            const currentSettings = yield* settingsService.getSettings;
            if (!currentSettings.worktreeArtifactEviction) return "setting was switched off";
            const current = yield* projections.getThreadShell(thread.id);
            if (
              current === null ||
              path.resolve(current.worktreePath ?? "") !== cwd ||
              current.branch !== thread.branch
            )
              return "thread workspace changed";
            if (!guards.idle(current, now))
              return "thread is running or has queued or pending work";
            if (guards.hasTerminal(cwd) || guards.hasTerminal(canonicalCwd)) return "open terminal";
            if (
              current.settledAt === null &&
              guards.activityAt(current) >
                now - currentSettings.worktreeArtifactEvictionDays * DAY_MS
            )
              return `inactive for less than ${currentSettings.worktreeArtifactEvictionDays} days`;
            if (
              current.settledAt !== null &&
              now -
                Math.max(DateTime.toEpochMillis(current.settledAt), guards.activityAt(current)) <
                60_000
            )
              return "settled moments ago";
            const ownership = yield* sql<{
              worktreePath: string;
            }>`SELECT json_extract(payload_json, '$.worktreePath') AS "worktreePath" FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL`;
            const owners = yield* Effect.filter(ownership, (owner) =>
              canonical(owner.worktreePath).pipe(Effect.map((key) => key === canonicalCwd)),
            );
            if (owners.length !== 1) return "worktree ownership changed";
            const pending =
              yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1`;
            if (pending.length > 0) return "thread has pending work";
            const live = yield* sql<{
              id: string;
              cwd: string;
            }>`SELECT provider_session_id AS "id", json_extract(payload_json, '$.cwd') AS "cwd" FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'`;
            for (const session of live) {
              const relative = path.relative(canonicalCwd, yield* canonical(session.cwd));
              if (
                (relative === "" ||
                  (!path.isAbsolute(relative) &&
                    relative !== ".." &&
                    !relative.startsWith(`..${path.sep}`))) &&
                (yield* sessions.isLive(session.id as Parameters<typeof sessions.isLive>[0]))
              )
                return "provider session is still open";
            }
            return null;
          }).pipe(Effect.orElseSucceed(() => "thread state could not be checked"));
          yield* withWorkspaceLease(
            cwd,
            Effect.gen(function* () {
              const reason = yield* blocked;
              if (reason !== null) return keep(reason);
              if (!(yield* fs.exists(cwd))) return keep("workspace folder is missing");
              const allProjects = yield* projects.listShells();
              for (const project of allProjects) {
                const real = yield* fs
                  .realPath(project.workspaceRoot)
                  .pipe(Effect.orElseSucceed(() => path.resolve(project.workspaceRoot)));
                const relative = path.relative(yield* fs.realPath(cwd), real);
                if (
                  relative === "" ||
                  (!path.isAbsolute(relative) &&
                    relative !== ".." &&
                    !relative.startsWith(`..${path.sep}`))
                )
                  return keep("contains a project checkout");
              }
              const project = yield* projects.get(thread.projectId);
              if (
                Option.isNone(project) ||
                !setupProjectScript(
                  resolveProjectScripts(settings, {
                    ...project.value,
                    id: project.value.projectId,
                  }),
                )
              )
                return keep("no project setup script is configured");
              const [expected, actual, branch] = yield* Effect.all([
                git.execute({
                  cwd: project.value.workspaceRoot,
                  args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                  operation: "inspect artifact repository",
                }),
                git.execute({
                  cwd,
                  args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                  operation: "inspect artifact worktree",
                }),
                git.execute({
                  cwd,
                  args: ["symbolic-ref", "HEAD"],
                  operation: "inspect artifact branch",
                }),
              ]);
              if (
                (yield* canonical(expected.stdout.trim())) !==
                  (yield* canonical(actual.stdout.trim())) ||
                branch.stdout.trim() !== `refs/heads/${thread.branch}`
              )
                return keep("repository or branch changed");
              const result = yield* artifacts.evict({ cwd, blocked });
              report({
                ...entry,
                outcome: result.failed ? "failed" : result.directories > 0 ? "removed" : "kept",
                reason: result.directories > 0 ? result.reason : `Artifacts kept: ${result.reason}`,
                bytes: result.directories > 0 ? result.bytes : null,
                artifactBreakdown: result.artifactBreakdown,
              });
            }).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  keep("inspection failed");
                }),
              ),
            ),
          );
        }
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            entries.push({
              kind: "worktree",
              outcome: "failed",
              reason: "Artifact cleanup could not inspect thread ownership",
              path: null,
              threadId: null,
              threadTitle: null,
              bytes: null,
              files: null,
            });
          }),
        ),
      );
  });
