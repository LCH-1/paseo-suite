import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Settings Sync commits this non-secret marker after credential changes. */
export function usageRevision(home: string, invalidate: () => void) {
  let previous: string | null = null;
  return async () => {
    let current: string | null;
    try { current = await readFile(join(home, "settings-sync", "credential-revision"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; current = null; }
    if (current !== previous) {
      previous = current;
      invalidate();
      return true;
    }
    return false;
  };
}
