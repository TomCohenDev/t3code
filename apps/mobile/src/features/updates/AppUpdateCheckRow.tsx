import * as Dialog from "../../components/ui/Dialog";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { msg, useGT } from "gt-react-native";

import { m } from "../../i18n/messages";
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
  const gt = useGT();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer clears the "Up to date" label
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
      ? gt("Checking…")
      : updateState === "downloading"
        ? gt("Downloading…")
        : updateState === "ready"
          ? gt("Update ready")
          : updateState === "restarting"
            ? gt("Restarting…")
            : updateState === "current"
              ? gt("Up to date")
              : null;

  return (
    <SettingsActionRow
      icon="arrow.clockwise"
      label={gt("Check for updates")}
      description={statusLabel ?? undefined}
      disabled={busy}
      loading={busy}
      onPress={() => {
        if (updateInFlight.current) return;
        updateInFlight.current = true;
        void settlePromise(() =>
          runAppUpdateCheck({
            applyMode: "immediate",
            onFailure: (message) => Dialog.alert(m(msg("Update failed")), message),
            onStateChange: setUpdateState,
          }),
        ).finally(() => {
          updateInFlight.current = false;
        });
      }}
    />
  );
}
