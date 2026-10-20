import * as Dialog from "../../components/ui/Dialog";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  runAppUpdateCheck,
} from "./app-updates";

/**
 * Visible check control for fork APK / OTA updates. About used to hide this behind
 * five taps on the version row, which Android testers never found.
 */
export function AppUpdateCheckRow() {
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);

  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  if (!isAppUpdateCheckAvailable()) return null;

  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";
  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : null;

  return (
    <SettingsActionRow
      icon="arrow.clockwise"
      label="Check for updates"
      description={statusLabel ?? undefined}
      disabled={busy}
      loading={busy}
      onPress={() => {
        if (updateInFlight.current) return;
        updateInFlight.current = true;
        void settlePromise(() =>
          runAppUpdateCheck({
            applyMode: "immediate",
            onFailure: (message) => Dialog.alert("Update failed", message),
            onStateChange: setUpdateState,
          }),
        ).finally(() => {
          updateInFlight.current = false;
        });
      }}
    />
  );
}
