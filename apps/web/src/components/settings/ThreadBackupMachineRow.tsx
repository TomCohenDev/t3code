import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: the `threadBackupMachine` setting (fork/threadBackup/ThreadBackups.ts). */
export function ThreadBackupMachineRow() {
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadBackupMachine"]);
  const edited = useRef(false);
  return (
    <SettingsRow
      {...setting("thread-backup-machine")}
      description="The kitshn name of a machine that keeps a copy of this machine's thread transcripts, for Continue on another machine while this one is offline. Needs standard access. Empty keeps no copy."
      serverScoped
      settingKeys={["threadBackupMachine"]}
      resetAction={
        mixed || settings.threadBackupMachine !== "" ? (
          <SettingResetButton
            ariaLabel="Reset thread backups to default"
            onClick={() => updateSettings({ threadBackupMachine: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${mixed}:${settings.threadBackupMachine}`}
          aria-label="Thread backup machine"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "Off"}
          defaultValue={mixed ? "" : settings.threadBackupMachine}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.threadBackupMachine)) {
              updateSettings({ threadBackupMachine: value });
            }
            edited.current = false;
          }}
        />
      }
    />
  );
}
