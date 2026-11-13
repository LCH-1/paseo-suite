import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Settings Sync commits this non-secret marker after credential changes. The first read only
 * records where it stands: a plugin that just started has no usage of its own to drop, and
 * treating that read as a change forced a vendor lookup on the first session it opened.
 */
export function usageRevision(home: string, onChange: () => void) {
  let previous: string | null = null;
  let known = false;
  return async () => {
    let current: string | null;
    try {
      current = await readFile(
        join(home, "settings-sync", "credential-revision"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = null;
    }
    if (!known) {
      known = true;
      previous = current;
      return false;
    }
    if (current !== previous) {
      previous = current;
      onChange();
      return true;
    }
    return false;
  };
}
