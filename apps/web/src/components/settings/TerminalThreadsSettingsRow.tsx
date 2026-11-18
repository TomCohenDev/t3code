import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `terminalThreads`, threads whose main view is a terminal. */
export function TerminalThreadsSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalThreads"]);

  return (
    <SettingsRow
      {...searchableSetting("terminal-threads")}
      serverScoped
      settingKeys={["terminalThreads"]}
      description="The sidebar and command palette offer New terminal thread, a thread whose view is a terminal. A message from a schedule or an agent is typed into it. A webhook task never types into one."
      resetAction={
        mixed || settings.terminalThreads !== DEFAULT_SERVER_SETTINGS.terminalThreads ? (
          <SettingResetButton
            ariaLabel="Reset terminal threads to default"
            onClick={() =>
              updateSettings({ terminalThreads: DEFAULT_SERVER_SETTINGS.terminalThreads })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["terminalThreads"]}
          checked={settings.terminalThreads}
          onCheckedChange={(checked) => updateSettings({ terminalThreads: Boolean(checked) })}
          aria-label="Terminal threads"
        />
      }
    />
  );
}
