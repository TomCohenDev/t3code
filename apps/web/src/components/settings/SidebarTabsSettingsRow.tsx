import {
  type ClientSettings,
  type ClientSettingsPatch,
  DEFAULT_CLIENT_SETTINGS,
} from "@t3tools/contracts";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useSelectedCircleSettings, useWriteSelectedCircle } from "../../machineMap/circleSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.sidebarTabsEnabled;
const selectSingleThreadOpens = (settings: ClientSettings) => settings.sidebarTabSingleThreadOpens;

/** Fork: `sidebarTabsEnabled` and `sidebarTabSingleThreadOpens`, sidebar tabs. */
export function SidebarTabsSettingsRow() {
  // Fork: with a circle picked in the person picker, the row shows and sets that circle's values.
  const circleValues = useSelectedCircleSettings();
  const writeCircle = useWriteSelectedCircle();
  const ownEnabled = useClientSettings(selectEnabled);
  const ownSingleThreadOpens = useClientSettings(selectSingleThreadOpens);
  const enabled = circleValues.sidebarTabsEnabled ?? ownEnabled;
  const singleThreadOpens = circleValues.sidebarTabSingleThreadOpens ?? ownSingleThreadOpens;
  const update = (patch: ClientSettingsPatch) =>
    writeCircle === null ? void updateClientSettings(patch) : writeCircle(patch);
  return (
    <>
      <SettingsRow
        {...searchableSetting("sidebar-tabs")}
        description="Put threads in tabs above the sidebar list. Drag a thread onto a tab, or onto the end of the tab bar for a new tab. Rules fill tabs too. kitshn syncs the tabs."
        resetAction={
          enabled !== DEFAULT_CLIENT_SETTINGS.sidebarTabsEnabled ? (
            <SettingResetButton
              label="sidebar tabs"
              onClick={() =>
                update({
                  sidebarTabsEnabled: DEFAULT_CLIENT_SETTINGS.sidebarTabsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => update({ sidebarTabsEnabled: Boolean(checked) })}
            aria-label="Sidebar tabs"
          />
        }
      />
      {enabled ? (
        <SettingsRow
          {...searchableSetting("sidebar-tab-single-thread")}
          description="A tab with one thread shows that thread, and a click opens it."
          resetAction={
            singleThreadOpens !== DEFAULT_CLIENT_SETTINGS.sidebarTabSingleThreadOpens ? (
              <SettingResetButton
                label="single-thread tabs"
                onClick={() =>
                  update({
                    sidebarTabSingleThreadOpens:
                      DEFAULT_CLIENT_SETTINGS.sidebarTabSingleThreadOpens,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={singleThreadOpens}
              onCheckedChange={(checked) =>
                update({ sidebarTabSingleThreadOpens: Boolean(checked) })
              }
              aria-label="Single-thread tabs open the thread"
            />
          }
        />
      ) : null}
    </>
  );
}
