/**
 * Fork: the person picker of T3 Settings. The owner picks a kitshn circle, and a change goes into
 * that circle's part of `t3.settings` instead of the shared or machine part.
 */
import {
  type MachineMapCircleSettings,
  MachineMapRequestError,
  type UnifiedSettings,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useLocation } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { UsersIcon } from "lucide-react";
import type { ComponentType } from "react";

import { useOptionalSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  splitScopedSettingsPatch,
  type ScopedSettingsPatch,
} from "../components/settings/scopedSettings";
import type { ScopeMenuProps } from "../components/settings/SettingsScopeSentence";
import type { SettingsScopeSearch } from "../components/settings/settingsScope";
import {
  ALL_PEOPLE_VALUE,
  personAxisValue,
  selectPersonAxis,
  SETTINGS_PERSON_PATHS,
} from "../components/settings/settingsScopeAxis";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/environments";
import { setMachineMapCircleSettings, useMachineMapState } from "../state/machineMap";
import { useAtomCommand } from "../state/use-atom-command";
import {
  circlePartSettings,
  circleSettingsChange,
  personPickerCircles,
} from "./circleSettings.logic";

/**
 * True when the write went through. A refusal shows kitshn's text as it is, for example from a
 * kitshn older than protocol 2.3.0; the write is not tried again.
 */
const isMachineMapRequestError = Schema.is(MachineMapRequestError);

function reportCircleWrite(result: AtomCommandResult<unknown, unknown>): boolean {
  if (AsyncResult.isSuccess(result)) return true;
  const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
  toastManager.add({
    type: "error",
    title: "Circle setting not saved",
    description: isMachineMapRequestError(error) ? error.detail : "The environment request failed.",
  });
  return false;
}

/** The circles that the owner can pick on this settings page; empty elsewhere and for others. */
export function useSettingsPersonPicker() {
  const environmentId = usePrimaryEnvironmentId();
  const { state } = useMachineMapState(environmentId);
  const pathname = useLocation({ select: (location) => location.pathname });
  const circles = SETTINGS_PERSON_PATHS.has(pathname) ? personPickerCircles(state) : [];
  return { environmentId, circles };
}

/** The circle that the owner picked on this page, or null for All people. */
export function useSelectedSettingsCircle() {
  const context = useOptionalSettingsScope();
  const { environmentId, circles } = useSettingsPersonPicker();
  const id = context?.search.circle;
  const circle = id === undefined ? undefined : circles.find((candidate) => candidate.id === id);
  return circle === undefined || environmentId === null ? null : { environmentId, circle };
}

/** The picked circle's values, to show over the saved ones; empty for All people. */
export function useSelectedCircleSettings(): Partial<UnifiedSettings> {
  return circlePartSettings(useSelectedSettingsCircle()?.circle.settings ?? null);
}

/**
 * A write into the picked circle's part, or null for All people. A key that a circle part cannot
 * hold is not saved, with a toast, so a circle write never changes a value of every person.
 */
export function useWriteSelectedCircle() {
  const selected = useSelectedSettingsCircle();
  const send = useAtomCommand(setMachineMapCircleSettings, { reportFailure: false });
  if (selected === null) return null;
  const { environmentId, circle } = selected;
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) => {
    const { serverPatch, clientPatch } = splitScopedSettingsPatch(patch);
    const change = circleSettingsChange(serverPatch, clientPatch);
    if (change.refused.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: `${change.refused.join(", ")} applies to all people. Pick All people to change it.`,
      });
      options?.onFailed?.();
      return;
    }
    void send({
      environmentId,
      // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the client settings scope, not an RPC client.
      input: { circleId: circle.id, server: change.server, client: change.client },
    }).then((result) => {
      if (!reportCircleWrite(result)) options?.onFailed?.();
    });
  };
}

/** Removes the picked circle's part, so the circle inherits every value again. */
function useResetSelectedCircle() {
  const selected = useSelectedSettingsCircle();
  const send = useAtomCommand(setMachineMapCircleSettings, { reportFailure: false });
  if (selected === null || selected.circle.settings === null) return null;
  const { environmentId, circle } = selected;
  return () =>
    void send({
      environmentId,
      input: { circleId: circle.id, server: {}, client: {}, reset: true },
    }).then(reportCircleWrite);
}

function CircleDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full bg-muted-foreground/50"
      style={color === null ? undefined : { backgroundColor: color }}
    />
  );
}

/**
 * The person picker of the scope sentence: "All people", or one kitshn circle whose part a
 * change goes into, with "Reset <circle>" when that circle has values. `Menu` is the sentence's
 * own scope menu, so the three pickers look alike.
 */
export function PersonScope({
  value,
  circles,
  onChange,
  Menu,
}: {
  value: SettingsScopeSearch;
  circles: readonly MachineMapCircleSettings[];
  onChange: (next: SettingsScopeSearch) => void;
  Menu: ComponentType<ScopeMenuProps>;
}) {
  const reset = useResetSelectedCircle();
  const selected = circles.find((circle) => circle.id === value.circle);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Menu
        ariaLabel="Person scope"
        icon={selected ? <CircleDot color={selected.color} /> : null}
        label={selected?.name ?? "All people"}
        value={selected ? personAxisValue(value) : ALL_PEOPLE_VALUE}
        onChange={(next) => onChange(selectPersonAxis(value, next))}
        searchLabel="Search circles"
        allOption={{
          value: ALL_PEOPLE_VALUE,
          label: "All people",
          icon: <UsersIcon aria-hidden className="size-3.5 shrink-0" />,
        }}
        options={circles.map((circle) => ({
          value: circle.id,
          label: circle.name,
          secondary: circle.settings === null ? "Inherits every value" : "Has its own values",
          icon: <CircleDot color={circle.color} />,
        }))}
      />
      {reset && selected ? (
        <Button variant="ghost" size="sm" onClick={reset}>
          Reset {selected.name}
        </Button>
      ) : null}
    </span>
  );
}
