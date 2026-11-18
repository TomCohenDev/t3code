import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function PreferOriginRemoteSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["preferOriginRemote"]);

  return (
    <SettingsRow
      {...searchableSetting("prefer-origin-remote")}
      serverScoped
      settingKeys={["preferOriginRemote"]}
      description="A checkout with an origin and an upstream remote counts as its origin, so pull requests come from your fork. To create pull requests on the fork too, run gh repo set-default in the checkout."
      resetAction={
        mixed || settings.preferOriginRemote !== DEFAULT_SERVER_SETTINGS.preferOriginRemote ? (
          <SettingResetButton
            ariaLabel="Reset pull requests from origin to default"
            onClick={() =>
              updateSettings({
                preferOriginRemote: DEFAULT_SERVER_SETTINGS.preferOriginRemote,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["preferOriginRemote"]}
          checked={settings.preferOriginRemote}
          onCheckedChange={(checked) => updateSettings({ preferOriginRemote: Boolean(checked) })}
          aria-label="Pull requests from origin"
        />
      }
    />
  );
}
