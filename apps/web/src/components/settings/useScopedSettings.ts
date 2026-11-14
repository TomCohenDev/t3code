import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useShareToMachineMap } from "../../machineMap/shareSettings";
import { useSelectedCircleSettings, useWriteSelectedCircle } from "../../machineMap/circleSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  createScopedSettingsWriter,
  pendingScopedWritesAtom,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  settlePendingScopedWrites,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

const readSettings = (environmentId: EnvironmentId) =>
  readEnvironment(environmentId)?.serverConfig?.settings ?? null;
const writeScopedSettings = createScopedSettingsWriter(readSettings);

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  // Fork: with a circle picked, the rows show that circle's values over the saved ones.
  const circleValues = useSelectedCircleSettings();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, (settings) => {
    const shown =
      Object.keys(circleValues).length === 0 ? settings : { ...settings, ...circleValues };
    return selector ? selector(shown) : (shown as T);
  });
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (
    environments: Parameters<typeof writeScopedSettings>[0],
    planner: Parameters<typeof writeScopedSettings>[1],
    options?: {
      readonly onFailed?: () => void;
      // Fork: MM-411. Runs after the save with the first plan and the environments that saved it.
      readonly onSaved?: (
        plan: ReturnType<typeof planScopedSettingsPatch>,
        saved: readonly { readonly environmentId: EnvironmentId }[],
      ) => void;
    },
  ) => {
    const onFailed = options?.onFailed;
    const onSaved = options?.onSaved;
    const plan = planner(environments);
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return;
    }
    const save = {};
    const settle = (environmentId: EnvironmentId, saved?: ServerSettings) =>
      appAtomRegistry.update(pendingScopedWritesAtom, (writes) =>
        settlePendingScopedWrites(
          writes,
          { save, environmentId },
          (id) => readSettings(id) ?? undefined,
          saved,
        ),
      );
    appAtomRegistry.update(pendingScopedWritesAtom, (writes) => [
      ...writes,
      ...plan.serverWrites.map(({ environmentId, patch }) => ({ save, environmentId, patch })),
    ]);
    void writeScopedSettings(
      environments,
      planner,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        const result = missing
          ? AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            )
          : await persistServer(request).catch((error: unknown) => {
              settle(request.environmentId);
              throw error;
            });
        settle(request.environmentId, result._tag === "Success" ? result.value : undefined);
        return result;
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      onSaved?.(plan, savedEnvironments);
      if (failedEnvironments.length === 0) return;
      onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
        description: [
          ...failedEnvironments.map(
            ({ label, message }) => `Could not save on ${label}: ${message}`,
          ),
          ...(savedEnvironmentCount > 0
            ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlan();
  const shareToMachineMap = useShareToMachineMap();
  const writeCircle = useWriteSelectedCircle();
  const selectedCircle = useOptionalSettingsScope()?.search.circle;
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) => {
    // Fork: with a circle picked, the change goes into that circle's part only.
    if (writeCircle !== null) return writeCircle(patch, options);
    // Fork: a picked circle that the map no longer lists must not fall through to another scope.
    if (selectedCircle !== undefined) {
      options?.onFailed?.();
      return;
    }
    run(environments, (current) => planScopedSettingsPatch(scope, current, patch, { deviceOnly }), {
      ...(options?.onFailed === undefined ? {} : { onFailed: options.onFailed }),
      // Fork: MM-411. A change for all environments also becomes the shared value of the map.
      ...(scope.kind === "all" ? { onSaved: shareToMachineMap } : {}),
    });
  };
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(context.environments, (current) => planScopedSettingsClear(context.scope, current, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(context.environments, (current) => planProjectOverridesClear(current, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
