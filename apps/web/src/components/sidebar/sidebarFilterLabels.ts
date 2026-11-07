/** Fork: the names that the sidebar filter menu and chips show for filter values. */
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import {
  NO_FILTER_VALUE,
  parseSidebarModelFilterValue,
  type SidebarFilterField,
} from "../filters/sidebarFilters.logic";
import type { SidebarProviderEntry } from "./SidebarThreadRow";

export type SidebarFilterLabeler = (field: SidebarFilterField, value: string) => string;

export function makeSidebarFilterLabeler(input: {
  readonly projectNameByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  /** Provider entries by environment, then by instance id. */
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, SidebarProviderEntry>
  >;
}): SidebarFilterLabeler {
  const modelLabel = (value: string) => {
    const { instanceId, model } = parseSidebarModelFilterValue(value);
    for (const entries of input.providerEntriesByEnvironment.values()) {
      const entry = entries.get(instanceId);
      const known = entry?.models.find((candidate) => candidate.slug === model);
      if (entry && known) {
        return `${getTriggerDisplayModelName(known, entry.driverKind)} · ${entry.displayName}`;
      }
    }
    return `${model} · ${instanceId}`;
  };
  return (field, value) => {
    switch (field) {
      case "project":
        return input.projectNameByKey.get(value) ?? "Unknown project";
      case "machine":
        return input.environmentLabelById.get(value) ?? value;
      case "model":
        return modelLabel(value);
      case "branch":
        return value === NO_FILTER_VALUE ? "No branch" : value;
      case "owner":
        return value === NO_FILTER_VALUE ? "No repository owner" : value;
    }
  };
}
