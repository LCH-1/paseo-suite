import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { rpc, type Summary } from "../shared/rpc";
import type { RestoreStatus } from "../shared/manual-restore-rpc";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Snapshot, ClientState } from "../shared/model";
import { availableScopes, filterSnapshot, mergeSnapshot, normalizeScopes, offStatus, selectClient, stableString, type AutoScopes, type AutoScopesInput } from "../shared/automation";
import { decrypt, encrypt } from "./crypto";
import { Environment } from "./environment";
import { GitHubVault } from "./github";
import { GitHubLogin } from "./login";
import { mergeCredentialFreshness } from "../shared/provider-credentials";

type PaseoApi = PluginHandlerContext["paseo"];
type RestoreJob = { previewId: string; signature: string; requireRelease: boolean; done: Promise<void>; status: Exclude<RestoreStatus, { state: "missing" }> };
type Session = { vault: GitHubVault; password: string; login: string; sha: string | null; touched: number; restore?: RestoreJob; preview?: { id: string; snapshot: Snapshot; selected: Snapshot; scopes: AutoScopes; fingerprint: string; at: number } };
function requestedScopes(input: RpcInput<typeof rpc.restore>) {
  return input.scopes ? { ...normalizeScopes(input.scopes), config: input.config && input.scopes.config, plugins: input.plugins && input.scopes.plugins } : normalizeScopes({ config: input.config, plugins: input.plugins });
}
function providerIds(snapshot: Snapshot) {
  const providers = snapshot.config.providers;
  return providers && typeof providers === "object" && !Array.isArray(providers) ? Object.keys(providers) : [];
}
export class SyncService {
  private sessions = new Map<string, Session>();
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed: Promise<void> | null = null;
  private sweep = setInterval(() => this.cleanup(), 60_000);
  constructor(private environment = new Environment(), private vaultFactory = (token: string) => new GitHubVault(token), private authentication = new GitHubLogin(), private now = Date.now) { this.sweep.unref(); }

  serial<T>(work: () => Promise<T>) {
    if (this.closing) return Promise.reject<T>(new Error("Settings Sync가 종료 중입니다. 다시 연결한 뒤 시도하세요."));
    const next = this.tail.then(() => {
      if (this.closing) throw new Error("Settings Sync가 종료 중입니다. 다시 연결한 뒤 시도하세요.");
      return work();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private cleanup() {
    for (const [id, session] of this.sessions) if (session.restore?.status.state !== "running" && this.now() - session.touched >= 30 * 60_000) this.sessions.delete(id);
    this.authentication.cleanup();
  }

  start(force = false) { return this.authentication.start(force); }
  async poll(flowId: string) { return this.authentication.poll(flowId); }
  cancel(flowId: string) { this.authentication.remove(flowId); return { ok: true }; }

  async connect(input: RpcInput<typeof rpc.connect>) {
    this.cleanup();
    if (this.sessions.size >= 10) throw new Error("열린 동기화 세션이 너무 많습니다.");
    const { token, login: expectedLogin } = this.authentication.credentials(input.flowId);
    const vault = this.vaultFactory(token);
    const login = await vault.verify();
    if (login !== expectedLogin) throw new Error("GitHub 인증 계정이 변경되었습니다. 다시 로그인하세요.");
    const remote = await vault.read();
    const snapshot = remote.raw ? await decrypt(remote.raw, input.password) : null;
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { vault, password: input.password, login, sha: remote.sha, touched: this.now() });
    this.authentication.remove(input.flowId);
    return { sessionId, login, hasBackup: Boolean(snapshot), createdAt: snapshot?.createdAt ?? null };
  }

  async resume(id: string) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session) return null;
    const remote = await session.vault.read();
    const snapshot = remote.raw ? await decrypt(remote.raw, session.password) : null;
    if (remote.sha !== session.sha) { session.sha = remote.sha; session.preview = undefined; }
    session.touched = this.now();
    return { sessionId: id, login: session.login, hasBackup: Boolean(snapshot), createdAt: snapshot?.createdAt ?? null };
  }

  private session(id: string) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session) throw new Error("로그인이 만료되었습니다. 다시 연결하세요.");
    session.touched = this.now();
    return session;
  }

  authorizeAutomation(id: string) {
    const session = this.session(id);
    this.checkRestore(session);
    const { login, password, vault } = session;
    return { login, password, vault };
  }

  private checkRestore(session: Session) {
    const job = session.restore;
    if (job?.status.state === "running" || job?.requireRelease && job.status.state === "completed") throw new Error("진행 중인 복원의 앱 반영을 먼저 확인하세요.");
  }

  async push(id: string, client: ClientState, paseo: PaseoApi, scopesInput: AutoScopesInput = offStatus.scopes) {
    const session = this.session(id);
    this.checkRestore(session);
    const scopes = normalizeScopes(scopesInput);
    if (!Object.values(scopes).some(Boolean)) throw new Error("백업할 동기화 대상을 하나 이상 선택하세요.");
    const remote = await session.vault.read();
    if (remote.sha !== session.sha) throw new Error("다른 기기에서 백업을 변경했습니다. 최신 백업을 미리보기한 뒤 다시 시도하세요.");
    let current = filterSnapshot(await this.environment.capture(paseo, selectClient(client, scopes), scopes), scopes);
    const previous = remote.raw ? await decrypt(remote.raw, session.password) : null;
    if (scopes.providers && current.credentials && previous?.credentials) current = { ...current, credentials: mergeCredentialFreshness(previous.credentials, current.credentials) };
    const snapshot = mergeSnapshot(previous, current, scopes);
    const encrypted = await encrypt(snapshot, session.password);
    session.sha = await session.vault.write(encrypted, session.sha, true);
    session.preview = undefined;
    delete session.restore;
    return { createdAt: current.createdAt, plugins: current.plugins.length, hosts: current.client.hosts.length, providers: providerIds(current).length, authentications: current.credentials?.records.length ?? 0 };
  }

  async preview(id: string, paseo: PaseoApi, scopesInput: AutoScopesInput = offStatus.scopes): Promise<Summary> {
    const session = this.session(id);
    this.checkRestore(session);
    delete session.restore;
    if (!Object.values(normalizeScopes(scopesInput)).some(Boolean)) throw new Error("미리볼 동기화 대상을 하나 이상 선택하세요.");
    const remote = await session.vault.read();
    if (!remote.raw) throw new Error("아직 저장된 백업이 없습니다.");
    const snapshot = await decrypt(remote.raw, session.password);
    const previewId = randomUUID();
    const selected = filterSnapshot(snapshot, scopesInput);
    session.sha = remote.sha;
    session.preview = { id: previewId, snapshot, selected, scopes: availableScopes(snapshot, scopesInput), fingerprint: await this.environment.fingerprint(paseo, selected), at: this.now() };
    return { id: previewId, createdAt: selected.createdAt, device: selected.device,
      hosts: selected.client.hosts.map((host) => host.label ?? host.serverId), preferences: Object.keys(selected.client.preferences),
      config: Object.keys(selected.config), providers: providerIds(selected), authenticatedProviders: selected.credentials?.records.flatMap((record) => record.providerIds) ?? [], plugins: selected.plugins.map((p) => ({ id: p.id, enabled: p.enabled, files: Object.keys(p.files).length, settings: Object.keys(p.settings) })) };
  }

  startRestore(input: RpcInput<typeof rpc.restore>, paseo: PaseoApi, requireRelease = true): RestoreStatus {
    if (this.closing) throw new Error("Settings Sync가 종료 중입니다. 다시 연결한 뒤 시도하세요.");
    const session = this.session(input.sessionId);
    const signature = stableString({ previewId: input.previewId, scopes: requestedScopes(input) });
    const previous = session.restore;
    if (previous) {
      if (previous.previewId === input.previewId && previous.signature === signature) {
        previous.requireRelease ||= requireRelease;
        return structuredClone(previous.status);
      }
      throw new Error("이미 시작한 복원을 먼저 확인한 뒤 다시 미리보기를 여세요.");
    }
    this.restoration(session, input);
    const job: RestoreJob = { previewId: input.previewId, signature, requireRelease, done: Promise.resolve(), status: { state: "running" } };
    session.restore = job;
    const captured = structuredClone(input);
    job.done = this.serial(() => this.performRestore(captured, paseo)).then((result) => {
      job.status = { state: "completed", result };
      session.touched = this.now();
    }, (reason: unknown) => {
      job.status = { state: "failed", message: reason instanceof Error ? reason.message : "복원에 실패했습니다. 다시 미리보기를 여세요." };
      session.touched = this.now();
    });
    return structuredClone(job.status);
  }

  restoreStatus(id: string, previewId: string): RestoreStatus {
    const job = this.session(id).restore;
    return !job || job.previewId !== previewId ? { state: "missing" } : structuredClone(job.status);
  }

  releaseRestore(id: string, previewId: string) {
    const session = this.session(id), job = session.restore;
    if (!job) return { ok: true };
    if (job.previewId !== previewId) throw new Error("복원 작업이 일치하지 않습니다.");
    if (job.status.state === "running") throw new Error("복원이 진행 중입니다. 완료 후 다시 확인하세요.");
    delete session.restore;
    return { ok: true };
  }

  async restore(input: RpcInput<typeof rpc.restore>, paseo: PaseoApi): Promise<RpcOutput<typeof rpc.restore>> {
    this.startRestore(input, paseo, false);
    const job = this.session(input.sessionId).restore!;
    await job.done;
    if (job.status.state === "failed") throw new Error(job.status.message);
    if (job.status.state !== "completed") throw new Error("복원 작업이 완료되지 않았습니다.");
    return structuredClone(job.status.result);
  }

  private restoration(session: Session, input: RpcInput<typeof rpc.restore>) {
    const preview = session.preview;
    if (!preview || preview.id !== input.previewId || this.now() - preview.at > 5 * 60_000) throw new Error("백업 미리보기를 다시 여세요.");
    const requested = requestedScopes(input);
    if (!Object.values(requested).some(Boolean)) throw new Error("복원할 동기화 대상을 하나 이상 선택하세요.");
    const scopes = availableScopes(preview.snapshot, requested);
    if (Object.entries(scopes).some(([key, enabled]) => enabled && !preview.scopes[key as keyof AutoScopes])) throw new Error("복원할 동기화 대상이 변경되었습니다. 백업 미리보기를 다시 여세요.");
    return { preview, scopes };
  }

  private async performRestore(input: RpcInput<typeof rpc.restore>, paseo: PaseoApi) {
    const session = this.session(input.sessionId);
    const { preview, scopes } = this.restoration(session, input);
    const remote = await session.vault.read();
    if (remote.sha !== session.sha) throw new Error("미리보기 이후 백업이 변경되었습니다. 다시 미리보기를 여세요.");
    const selected = filterSnapshot(preview.snapshot, scopes);
    if (await this.environment.fingerprint(paseo, preview.selected) !== preview.fingerprint) throw new Error("미리보기 이후 이 호스트 설정이 변경되었습니다. 다시 미리보기를 여세요.");
    if (remote.conflicts) session.sha = await session.vault.write(remote.raw!, remote.sha, true);
    const fingerprint = await this.environment.fingerprint(paseo, selected);
    const backupDirectory = await this.environment.restore(paseo, selected, fingerprint, scopes);
    session.preview = undefined;
    return { client: selectClient(selected.client, scopes), scopes, backupDirectory };
  }

  disconnect(id: string) { this.sessions.delete(id); return { ok: true }; }
  dispose() {
    if (this.closed) return this.closed;
    this.closing = true;
    clearInterval(this.sweep);
    this.authentication.dispose();
    // The contribution cleanup is awaited by Paseo. Retain the active job's
    // session until it settles, and prevent already queued jobs from starting.
    this.closed = this.tail.then(() => { this.sessions.clear(); });
    return this.closed;
  }
}
