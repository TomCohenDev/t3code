import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const selectWhiteFrame = (settings: ClientSettings) => settings.inkwireWhiteFrame;

/** Fork: `inkwireWhiteFrame`, a chalk outline while an Inkwire theme is on. */
export function InkwireWhiteFrameSettingsRow() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const enabled = useClientSettings(selectWhiteFrame);
  return (
    <SettingsRow
      {...setting("inkwire-white-frame")}
      description={gt(
        "While an Inkwire theme is selected, draw a white chalk frame around the window and sketched controls. Static CSS only, so it does not affect scrolling.",
      )}
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.inkwireWhiteFrame ? (
          <SettingResetButton
            ariaLabel={gt("Reset Inkwire white frame to default")}
            onClick={() =>
              void updateClientSettings({
                inkwireWhiteFrame: DEFAULT_CLIENT_SETTINGS.inkwireWhiteFrame,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ inkwireWhiteFrame: Boolean(checked) })
          }
          aria-label={gt("Inkwire white frame")}
        />
      }
    />
  );
}
