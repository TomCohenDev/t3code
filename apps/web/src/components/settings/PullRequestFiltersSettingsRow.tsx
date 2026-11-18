import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.pullRequestFilters;

/** Fork: `pullRequestFilters`, the repository owner filter and the active filter chips. */
export function PullRequestFiltersSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const enabled = useClientSettings(selectEnabled);
  return (
    <SettingsRow
      {...searchableSetting("pull-request-filters")}
      description="Filter pull requests and sidebar projects by the account or organization that owns their repository. Show the active pull request filters as chips: click is or is not to flip one, or remove it."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.pullRequestFilters ? (
          <SettingResetButton
            ariaLabel="Reset pull request filters to default"
            onClick={() =>
              void updateClientSettings({
                pullRequestFilters: DEFAULT_CLIENT_SETTINGS.pullRequestFilters,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ pullRequestFilters: Boolean(checked) })
          }
          aria-label="Pull request filters"
        />
      }
    />
  );
}
