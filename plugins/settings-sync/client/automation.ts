import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { rpc } from "../shared/rpc";
import { normalizeScopes, offStatus, stableString, type AutoScopesInput, type AutoStatus } from "../shared/automation";
import { browserStorage, capture, restore, type StorageAdapter } from "./storage";

type Transport = {
  status(): Promise<AutoStatus>;
  enable(input: RpcInput<typeof rpc.autoEnable>): Promise<AutoStatus>;
  claim?(input: { clientId: string }): Promise<AutoStatus>;
  configure?(input: RpcInput<typeof rpc.autoConfigure>): Promise<AutoStatus>;
  disable(): Promise<AutoStatus>;
  tick(input: RpcInput<typeof rpc.autoTick>): Promise<RpcOutput<typeof rpc.autoTick>>;
  acknowledge(input: RpcInput<typeof rpc.autoAck>): Promise<AutoStatus>;
};
type ViewState = { status: AutoStatus; loading: boolean; busy: boolean; needsReload: boolean; owned: boolean };
export const clientIdKey = "@paseo:settings-sync-client-id";

export class AutoClient {
  private view: ViewState = { status: offStatus, loading: true, busy: false, needsReload: false, owned: false };
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;
  private nextAttempt = 0;
  constructor(private transport: Transport, private storage: () => StorageAdapter = browserStorage, private reload: (() => void) | null = typeof globalThis.location?.reload === "function" ? () => globalThis.location.reload() : null, private clientId: string | null = null) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ViewState>) {
    if (this.stopped) return;
    const next = { ...this.view, ...patch };
    this.view = { ...next, owned: next.status.enabled && this.clientId !== null && next.status.ownerClientId === this.clientId };
    for (const listener of this.listeners) listener();
  }
  private identity() {
    if (this.clientId) return this.clientId;
    const storage = this.storage();
    const saved = storage.getItem(clientIdKey);
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) return this.clientId = saved;
    const clientId = globalThis.crypto.randomUUID();
    storage.setItem(clientIdKey, clientId);
    return this.clientId = clientId;
  }
  private queue(work: () => Promise<void>) {
    const task = this.tail.then(work);
    this.tail = task.catch(() => undefined);
    return task;
  }
  private scheduleReload() {
    if (this.stopped || !this.reload || this.reloadTimer !== null || !this.view.owned || !this.view.needsReload || this.view.status.state !== "ready" || this.view.status.pendingOperations !== 0) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (this.stopped || this.view.busy || !this.view.owned || !this.view.needsReload || this.view.status.state !== "ready" || this.view.status.pendingOperations !== 0) return;
      this.update({ needsReload: false });
      this.reload?.();
    }, 0);
  }
  start() {
    void this.synchronize();
    this.timer = setInterval(() => {
      if (!this.view.busy && Date.now() >= this.nextAttempt) void this.synchronize();
    }, 30_000);
    return () => this.dispose();
  }
  private async perform(force?: "local" | "remote", retainBusy = false) {
    if (this.stopped) return;
    this.update({ busy: true });
    try {
      const clientId = this.identity();
      let status = await this.transport.status();
      this.update({ status });
      if (status.enabled && status.ownerClientId === clientId && (status.state !== "conflict" || force)) {
        const storage = this.storage();
        const scopes = normalizeScopes(status.scopes);
        const before = capture(storage, scopes);
        const result = await this.transport.tick({ clientId, client: before, ...(force ? { force } : {}) });
        if (this.stopped) return;
        status = { ...result.status, ownerClientId: result.status.ownerClientId ?? null };
        if (result.operation && status.ownerClientId === clientId) {
          if (stableString(capture(storage, scopes)) !== stableString(before)) throw new Error("동기화 중 앱 설정이 바뀌었습니다. 다음 동기화에서 충돌을 확인합니다.");
          const restoredScopes = normalizeScopes(result.operation.scopes ?? scopes);
          restore(storage, result.operation.client, { merge: false, hosts: restoredScopes.hosts, preferences: restoredScopes.preferences });
          if (stableString(capture(storage, scopes)) !== stableString(before)) this.update({ needsReload: true });
          status = await this.transport.acknowledge({ clientId, operationId: result.operation.id, client: capture(storage, scopes) });
        }
      }
      this.failures = status.state === "error" || status.state === "locked" ? Math.min(this.failures + 1, 4) : 0;
      this.update({ status });
    } catch (error) {
      this.failures = Math.min(this.failures + 1, 4);
      this.update({ status: { ...this.view.status, state: "error", message: error instanceof Error ? error.message : "연결을 확인하고 자동으로 다시 시도합니다." } });
    } finally {
      this.nextAttempt = Date.now() + Math.min(300_000, 30_000 * 2 ** this.failures);
      this.update({ loading: false, busy: retainBusy });
      this.scheduleReload();
    }
  }
  synchronize(force?: "local" | "remote") { return this.queue(() => this.perform(force)); }
  enable(sessionId: string, scopes: AutoScopesInput = offStatus.scopes) {
    return this.queue(async () => {
      this.update({ busy: true });
      try {
        this.update({ status: await this.transport.enable({ sessionId, scopes: normalizeScopes(scopes), clientId: this.identity() }) });
        await this.perform(undefined, true);
      } finally { this.update({ busy: false, loading: false }); this.scheduleReload(); }
    });
  }
  claim() {
    return this.queue(async () => {
      this.update({ busy: true });
      try {
        if (!this.transport.claim) throw new Error("현재 호스트가 동기화 담당 앱 연결을 지원하지 않습니다. 플러그인을 업데이트하세요.");
        this.update({ status: await this.transport.claim({ clientId: this.identity() }) });
        await this.perform(undefined, true);
      } finally { this.update({ busy: false, loading: false }); this.scheduleReload(); }
    });
  }
  configure(scopes: AutoScopesInput, takeOwnership = false) {
    return this.queue(async () => {
      if (this.stopped) return;
      this.update({ busy: true });
      try {
        const clientId = this.identity();
        const status = await this.transport.status();
        if (this.stopped) return;
        this.update({ status });
        const { owned } = this.view;
        if (!status.enabled) throw new Error("자동 동기화를 먼저 연결하세요.");
        if (!owned && !takeOwnership) throw new Error("이 앱을 동기화 담당으로 지정한 뒤 범위를 변경하세요.");
        if (status.pendingOperations !== 0) throw new Error("진행 중인 복원을 먼저 완료한 뒤 범위를 변경하세요.");
        if (!this.transport.configure) throw new Error("현재 호스트가 동기화 범위 변경을 지원하지 않습니다. 플러그인을 업데이트하세요.");
        const selected = normalizeScopes(scopes);
        this.update({ status: await this.transport.configure({ clientId, scopes: selected, client: capture(this.storage(), selected), ...(!owned && takeOwnership ? { takeover: { expectedOwnerClientId: status.ownerClientId } } : {}) }) });
        await this.perform(undefined, true);
      } finally { this.update({ busy: false, loading: false }); this.scheduleReload(); }
    });
  }
  disable() {
    return this.queue(async () => {
      this.update({ busy: true });
      try { this.update({ status: await this.transport.disable() }); }
      finally { this.update({ busy: false, loading: false }); }
    });
  }
  dispose() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.reloadTimer !== null) clearTimeout(this.reloadTimer); this.listeners.clear(); }
}
