import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `previewLocalServerGroups`, the groups of the browser "Local servers" list. */
export function PreviewLocalServerGroupsSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["previewLocalServerGroups"]);

  return (
    <SettingsRow
      {...searchableSetting("preview-local-server-groups")}
      serverScoped
      settingKeys={["previewLocalServerGroups"]}
      description="A new browser tab also lists servers that no T3 terminal started: the thread's worktree first, then its project, then the others. Servers outside every project are not checked."
      resetAction={
        mixed ||
        settings.previewLocalServerGroups !== DEFAULT_SERVER_SETTINGS.previewLocalServerGroups ? (
          <SettingResetButton
            ariaLabel="Reset all local servers to default"
            onClick={() =>
              updateSettings({
                previewLocalServerGroups: DEFAULT_SERVER_SETTINGS.previewLocalServerGroups,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["previewLocalServerGroups"]}
          checked={settings.previewLocalServerGroups}
          onCheckedChange={(checked) =>
            updateSettings({ previewLocalServerGroups: Boolean(checked) })
          }
          aria-label="All local servers in the browser"
        />
      }
    />
  );
}
