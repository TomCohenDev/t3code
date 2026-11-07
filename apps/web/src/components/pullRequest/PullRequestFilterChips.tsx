import { FilterChipList } from "../filters/FilterChipList";
import {
  clearPullRequestFilterChips,
  type PullRequestFilterChip,
} from "./pullRequestFilterChips.logic";
import type { PullRequestListPreferencePatch } from "./pullRequestListPreferences";

/**
 * Fork: the active menu filters above the pull request list, shown while the
 * `pullRequestFilters` setting is on. If upstream T3 Code ships its own active-filter chips,
 * drop this fork version and use theirs.
 */
export function PullRequestFilterChips({
  chips,
  onChange,
}: {
  readonly chips: ReadonlyArray<PullRequestFilterChip>;
  readonly onChange: (patch: PullRequestListPreferencePatch) => void;
}) {
  return (
    <FilterChipList
      chips={chips.map((chip) => {
        const flip = chip.flip;
        return {
          key: chip.key,
          field: chip.field,
          operator: chip.operator,
          value: chip.value,
          onFlip: flip ? () => onChange(flip) : undefined,
          onRemove: () => onChange(chip.remove),
        };
      })}
      onClearAll={() => onChange(clearPullRequestFilterChips(chips))}
    />
  );
}
