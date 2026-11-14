import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

/** Fork: a normal chat thread or a terminal thread (`forkTerminalThreads.ts`). */
export type NewThreadKind = "chat" | "terminal";

/** Fork: a context that can also start a terminal thread. */
export interface ForkThreadActionContext extends ChatThreadActionContext {
  /**
   * Opens a terminal draft (`forkTerminalThreads.ts`). `opensAsThread` makes the draft a
   * terminal thread at once, like its enlarge button.
   */
  readonly handleNewTerminalThread: (
    projectRef: ScopedProjectRef,
    options?: { readonly opensAsThread: boolean },
  ) => Promise<unknown>;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function threadHasStarted(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "itemCount" | "runtime"> | null | undefined,
): boolean {
  return Boolean(thread && (thread.latestRun !== null || thread.itemCount > 0 || thread.runtime));
}

/**
 * A draft is seeded from sticky state, project defaults, prompt links, or a carried selection.
 * That seed is what an unstarted thread sends; once the thread has started, its own selection
 * wins unless the user picked a model or traits for it.
 */
export function draftModelSelectionApplies(
  draft: Pick<ComposerThreadDraftState, "modelSelectionExplicit"> | null | undefined,
  threadStarted: boolean,
): boolean {
  return !threadStarted || draft?.modelSelectionExplicit === true;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export function startNewThreadFromContext(context: ChatThreadActionContext): Promise<boolean>;
export function startNewThreadFromContext(
  context: ForkThreadActionContext,
  kind: NewThreadKind,
): Promise<boolean>;
export async function startNewThreadFromContext(
  context: ChatThreadActionContext | ForkThreadActionContext,
  kind: NewThreadKind = "chat",
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  if (kind === "terminal") {
    if (!("handleNewTerminalThread" in context)) {
      throw new Error("A terminal thread needs a context with handleNewTerminalThread.");
    }
    // Fork: only this "in current project" path reads the setting. The project picker
    // (`ForkTerminalThreadPaletteItems.tsx`) keeps its terminal a draft until the first command.
    // Fork: a static import makes a cycle, because composerDraftStore imports this file.
    const { getClientSettings } = await import("../hooks/useSettings");
    await context.handleNewTerminalThread(projectRef, {
      opensAsThread: getClientSettings().currentProjectTerminalOpensThread,
    });
    return true;
  }
  await context.handleNewThread(projectRef);
  return true;
}
