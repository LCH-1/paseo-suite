import type { TitleSyncClient } from "./sdk-extension";

type WorkspaceApi = TitleSyncClient["paseo"]["workspaces"];
type WorkspacePage = Awaited<ReturnType<WorkspaceApi["list"]>>;
type WorkspaceSubscription = NonNullable<WorkspacePage["subscription"]>;
type Workspace = WorkspacePage["entries"][number];
type ProjectName = Pick<Workspace, "projectCustomName" | "projectDisplayName">;
type PendingSnapshot = { version: number; updates: Map<string, string | null> };
type ScheduleRetry = (callback: () => void, delay: number) => () => void;
const RETRY_DELAYS = [500, 1500, 4000] as const;
const scheduleRetry: ScheduleRetry = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

export class ProjectTitleCache {
  private readonly names = new Map<string, string>();
  private subscription: WorkspaceSubscription | null = null;
  private unsubscribe: (() => void) | null = null;
  private opening: Promise<void> | null = null;
  private releasing: Promise<void> | null = null;
  private cancelRetry: (() => void) | null = null;
  private retryCount = 0;
  private enabled = false;
  private includeBackground = true;
  private needsSnapshot = false;
  private epoch = 0;
  private snapshotVersion = 0;
  private pending: PendingSnapshot | null = null;

  constructor(private readonly workspaces: WorkspaceApi, private readonly invalidate: () => void,
    private readonly schedule: ScheduleRetry = scheduleRetry) {}

  get(workspaceId: string): string | null {
    return this.names.get(workspaceId) ?? null;
  }

  start(): void {
    this.enabled = true;
    this.resetRetries();
    this.resume();
  }

  stop(): void {
    this.enabled = false;
    this.epoch++;
    this.snapshotVersion++;
    this.pending = null;
    this.resetRetries();
    this.releaseSubscription();
    this.names.clear();
  }

  private live(epoch: number): boolean {
    return this.enabled && this.epoch === epoch;
  }

  private resetRetries(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.retryCount = 0;
  }

  private retry(epoch: number): void {
    if (!this.live(epoch) || this.cancelRetry || this.retryCount >= RETRY_DELAYS.length) return;
    const delay = RETRY_DELAYS[this.retryCount++];
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null;
      if (this.live(epoch)) this.resume();
    }, delay);
  }

  private resume(): void {
    if (!this.enabled || this.opening || this.pending) return;
    if (this.releasing) {
      const epoch = this.epoch;
      void this.releasing.then(() => { if (this.live(epoch)) this.resume(); });
      return;
    }
    const epoch = this.epoch;
    if (this.subscription) {
      if (this.needsSnapshot) void this.refreshSnapshot(epoch);
      return;
    }
    const opening = this.open(epoch).finally(() => {
      if (this.opening === opening) this.opening = null;
      if (this.enabled && this.epoch !== epoch) this.resume();
    });
    this.opening = opening;
  }

  private releaseSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const subscription = this.subscription;
    this.subscription = null;
    if (!subscription) return;
    const releasing = Promise.all([this.releasing, subscription.release().catch(() => {})]).then(() => {});
    this.releasing = releasing;
    void releasing.finally(() => { if (this.releasing === releasing) this.releasing = null; });
  }

  private name(workspace: ProjectName): string | null {
    const value = workspace.projectCustomName ?? workspace.projectDisplayName;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private async list(options: Parameters<WorkspaceApi["list"]>[0], epoch: number): Promise<WorkspacePage> {
    if (!this.live(epoch)) throw new Error("Project metadata cache stopped");
    try {
      return await this.workspaces.list({ ...options, includeBackground: this.includeBackground });
    } catch (error) {
      if (!this.live(epoch) || !this.includeBackground || !(error instanceof Error)
        || error.message !== "Update the host to use background workspaces.") throw error;
      this.includeBackground = false;
      return this.workspaces.list({ ...options, includeBackground: false });
    }
  }

  private async open(epoch: number): Promise<void> {
    try {
      const first = await this.list({ subscribe: {}, page: { limit: 200 } }, epoch);
      const subscription = first.subscription;
      if (!subscription) throw new Error("The host omitted its workspace subscription");
      if (!this.live(epoch)) {
        await subscription.release().catch(() => {});
        return;
      }
      this.subscription = subscription;
      const unsubscribe = subscription.subscribe({
        snapshot: (snapshot) => {
          if (!this.live(epoch) || this.subscription !== subscription) return;
          this.resetRetries();
          void this.readSnapshot(snapshot, epoch, this.beginSnapshot());
        },
        update: (message) => {
          if (!this.live(epoch) || this.subscription !== subscription || message.type !== "workspace_update") return;
          const update = message.payload;
          const id = update.kind === "upsert" ? update.workspace.id : update.id;
          const name = update.kind === "upsert" ? this.name(update.workspace) : null;
          this.pending?.updates.set(id, name);
          if (name === null) this.names.delete(id);
          else this.names.set(id, name);
          this.invalidate();
        },
        error: () => {
          if (!this.live(epoch) || this.subscription !== subscription) return;
          this.snapshotVersion++;
          this.pending = null;
          this.releaseSubscription();
          this.retry(epoch);
        },
      });
      if (this.subscription === subscription) this.unsubscribe = unsubscribe;
      else unsubscribe();
    } catch {
      if (this.live(epoch)) {
        this.releaseSubscription();
        this.retry(epoch);
      }
    }
  }

  private beginSnapshot(): PendingSnapshot {
    const pending = { version: ++this.snapshotVersion, updates: new Map<string, string | null>() };
    this.pending = pending;
    this.needsSnapshot = false;
    return pending;
  }

  private failedSnapshot(epoch: number, pending: PendingSnapshot): void {
    if (!this.live(epoch) || this.pending !== pending) return;
    this.pending = null;
    this.needsSnapshot = true;
    this.retry(epoch);
  }

  private async refreshSnapshot(epoch: number): Promise<void> {
    const pending = this.beginSnapshot();
    try {
      const first = await this.list({ page: { limit: 200 } }, epoch);
      await this.readSnapshot(first, epoch, pending);
    } catch { this.failedSnapshot(epoch, pending); }
  }

  private async readSnapshot(first: WorkspacePage, epoch: number, pending: PendingSnapshot): Promise<void> {
    const names = new Map<string, string>();
    const seen = new Set<string>();
    let page = first;
    try {
      while (true) {
        if (!this.live(epoch) || pending.version !== this.snapshotVersion) return;
        for (const workspace of page.entries) {
          const name = this.name(workspace);
          if (name !== null) names.set(workspace.id, name);
        }
        if (!page.pageInfo.hasMore) break;
        const cursor = page.pageInfo.nextCursor;
        if (!cursor || seen.has(cursor)) throw new Error("Invalid workspace pagination cursor");
        seen.add(cursor);
        page = await this.list({ page: { limit: 200, cursor } }, epoch);
      }
      if (!this.live(epoch) || pending.version !== this.snapshotVersion) return;
      for (const [id, name] of pending.updates) {
        if (name === null) names.delete(id);
        else names.set(id, name);
      }
      this.names.clear();
      for (const [id, name] of names) this.names.set(id, name);
      this.pending = null;
      this.resetRetries();
      this.invalidate();
    } catch { this.failedSnapshot(epoch, pending); }
  }
}
