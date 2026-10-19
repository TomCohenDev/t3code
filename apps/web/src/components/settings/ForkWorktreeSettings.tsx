import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function RestoreWorktreesSettingsRow() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("restore-worktrees-on-resume")}
      serverScoped
      settingKeys={["restoreWorktreesOnResume"]}
      description="Restore a missing checkout from its saved local branch, then run project setup before the next turn. Also runs setup when a Node project's dependencies are missing. Never creates or resets a branch."
      control={
        <ScopedSwitch
          settingKeys={["restoreWorktreesOnResume"]}
          checked={settings.restoreWorktreesOnResume}
          onCheckedChange={(checked) => update({ restoreWorktreesOnResume: Boolean(checked) })}
          aria-label="Restore worktrees on resume"
        />
      }
    />
  );
}
