import type { ComponentProps } from "react";

import { Button } from "../ui/button";
import { FilterChip } from "./FilterChip";

export type FilterChipItem = Omit<ComponentProps<typeof FilterChip>, "key"> & {
  readonly key: string;
};

/**
 * Fork: the active filters as chips, with "Clear all" from two chips up. The pull request page
 * and the sidebar both show it. If upstream ships its own active-filter chips, use theirs.
 */
export function FilterChipList({
  chips,
  onClearAll,
}: {
  readonly chips: ReadonlyArray<FilterChipItem>;
  readonly onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
      {chips.map(({ key, ...chip }) => (
        <FilterChip key={key} {...chip} />
      ))}
      {chips.length > 1 ? (
        <Button size="xs" variant="ghost-muted" onClick={onClearAll}>
          Clear all
        </Button>
      ) : null}
    </div>
  );
}
