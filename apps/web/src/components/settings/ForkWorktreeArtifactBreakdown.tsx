import type { ForkArtifactFolderType, StorageCleanupReportEntry } from "@t3tools/contracts";
import { formatBytes } from "../../lib/formatBytes";

const labels: Record<ForkArtifactFolderType, string> = {
  "android-build": "Android builds",
  "gradle-cache": "Gradle caches",
  "build-output": "Other builds",
  cache: "Other caches",
  node_modules: "node_modules",
};

export function ForkWorktreeArtifactBreakdown({
  breakdown,
}: {
  breakdown: StorageCleanupReportEntry["artifactBreakdown"];
}) {
  if (!breakdown?.length) return null;
  return (
    <span>
      {" "}
      Logical bytes removed:{" "}
      {breakdown
        .map(
          (entry) =>
            `${labels[entry.folderType]}: ${formatBytes(entry.logicalBytes)} (${entry.folders} ${entry.folders === 1 ? "folder" : "folders"})`,
        )
        .join("; ")}
      . Shared filesystem blocks can make physical space reclaimed much smaller.
    </span>
  );
}
