import type { TitleSyncClient } from "../client/sdk-extension";

export type WorkspaceApi = TitleSyncClient["paseo"]["workspaces"];
export type WorkspacePage = Awaited<ReturnType<WorkspaceApi["list"]>>;
export type WorkspaceSubscription = NonNullable<WorkspacePage["subscription"]>;
type Observer = Parameters<WorkspaceSubscription["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type Workspace = WorkspacePage["entries"][number];

export function workspace(id = "workspace-1", display = "cursor-setting-sync", custom: string | null = null): Workspace {
  return { id, projectId: "project-" + id, projectDisplayName: display, projectCustomName: custom } as Workspace;
}

export function page(entries: Workspace[] = [workspace()], nextCursor: string | null = null): WorkspacePage {
  return { requestId: "workspace-request", entries, pageInfo: {
    nextCursor, prevCursor: null, hasMore: nextCursor !== null,
  } };
}

export class FakeWorkspaceSubscription implements WorkspaceSubscription {
  readonly subscriptionId = "workspace-subscription";
  readonly ready: WorkspaceSubscription["ready"];
  observer: Observer | null = null;
  releases = 0;
  unsubscribes = 0;
  private snapshotValue: Snapshot;

  constructor(first: WorkspacePage) {
    this.snapshotValue = { ...first, subscriptionId: this.subscriptionId };
    this.ready = Promise.resolve(this.snapshotValue);
  }

  subscribe(observer: Observer): () => void {
    this.observer = observer;
    observer.snapshot(this.snapshotValue);
    return () => { this.unsubscribes++; this.observer = null; };
  }

  release = async (): Promise<void> => { this.releases++; this.observer = null; };

  snapshot(value: WorkspacePage): void {
    this.snapshotValue = { ...value, subscriptionId: this.subscriptionId };
    this.observer?.snapshot(this.snapshotValue);
  }

  upsert(value: Workspace): void {
    this.observer?.update({ type: "workspace_update", payload: { kind: "upsert", workspace: value } });
  }

  remove(id: string): void {
    this.observer?.update({ type: "workspace_update", payload: { kind: "remove", id } });
  }

  fail(): void { this.observer?.error?.(new Error("workspace observation failed")); }
}

export class FakeWorkspaceApi {
  first = page();
  readonly subscriptions: FakeWorkspaceSubscription[] = [];
  readonly calls: Array<Parameters<WorkspaceApi["list"]>[0]> = [];
  readonly pages = new Map<string, () => Promise<WorkspacePage>>();
  firstRead: (() => Promise<WorkspacePage>) | null = null;
  firstPageRead: (() => Promise<WorkspacePage>) | null = null;
  backgroundSupported = true;

  readonly api: WorkspaceApi = { list: async (options) => {
    this.calls.push(options);
    if (options?.includeBackground && !this.backgroundSupported) throw new Error("Update the host to use background workspaces.");
    if (options?.subscribe) {
      const first = await (this.firstRead?.() ?? Promise.resolve(this.first));
      const subscription = new FakeWorkspaceSubscription(first);
      this.subscriptions.push(subscription);
      return { ...first, subscription, subscriptionId: subscription.subscriptionId };
    }
    const cursor = options?.page?.cursor;
    if (!cursor) return this.firstPageRead?.() ?? this.first;
    const next = cursor && this.pages.get(cursor);
    if (!next) throw new Error("Unexpected workspace page");
    return next();
  } } as WorkspaceApi;
}
