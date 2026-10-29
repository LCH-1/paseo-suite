import { moduleIds, type ModuleId, type UiSettings } from "../shared/settings";

type Cleanup = () => void | Promise<void>;
export class UiModules {
  private active = new Map<ModuleId, Cleanup>();
  private stopped = false;
  private pending: Promise<void>[] = [];
  constructor(private readonly start: Record<ModuleId, () => Cleanup>) {}

  apply(settings: UiSettings) {
    if (this.stopped) return;
    const added: ModuleId[] = [];
    try {
      for (const id of moduleIds) {
        if (!settings.modules[id] || this.active.has(id)) continue;
        const cleanup = this.start[id]();
        if (typeof cleanup !== "function")
          throw new Error(`Paseo UI: ${id} cleanup is missing`);
        this.active.set(id, cleanup);
        added.push(id);
      }
    } catch (error) {
      for (const id of added.reverse()) this.remove(id);
      throw error;
    }
    for (const id of [...moduleIds].reverse())
      if (!settings.modules[id]) this.remove(id);
  }

  private remove(id: ModuleId) {
    const cleanup = this.active.get(id);
    if (!cleanup) return;
    this.active.delete(id);
    let result: Promise<void>;
    try {
      result = Promise.resolve(cleanup());
    } catch (error) {
      result = Promise.reject(error);
    }
    this.pending.push(result);
    void result.catch((error) =>
      console.error(`[paseo-ui] ${id} cleanup failed`, error),
    );
  }

  async dispose() {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of [...moduleIds].reverse()) this.remove(id);
    const results = await Promise.allSettled(this.pending.splice(0));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Paseo UI module cleanup failed");
  }
}
