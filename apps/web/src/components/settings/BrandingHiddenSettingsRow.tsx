import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const selectBrandingHidden = (settings: ClientSettings) => settings.brandingHidden;

/** Fork: `brandingHidden`, hides the sidebar wordmark and the environment pill. */
export function BrandingHiddenSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const hidden = useClientSettings(selectBrandingHidden);
  return (
    <SettingsRow
      {...searchableSetting("branding-hidden")}
      description="Hides the T3 Code wordmark in the sidebar and the build pill."
      resetAction={
        hidden !== DEFAULT_CLIENT_SETTINGS.brandingHidden ? (
          <SettingResetButton
            ariaLabel="Reset hide T3 branding to default"
            onClick={() =>
              void updateClientSettings({ brandingHidden: DEFAULT_CLIENT_SETTINGS.brandingHidden })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={hidden}
          onCheckedChange={(checked) =>
            void updateClientSettings({ brandingHidden: Boolean(checked) })
          }
          aria-label="Hide T3 branding"
        />
      }
    />
  );
}
