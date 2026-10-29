import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { clientStateSchema, legacyPreferenceKeys, snapshotSchema, type ClientState, type Snapshot } from "../shared/model";
import { autoScopesInputSchema, autoScopesSchema, availableScopes, clientContent, filterSnapshot, LEGACY_CLIENT_ID, mergeClients, mergeSnapshot, normalizeScopes, offStatus, replacePortableClient, selectClient, selectConfig, serverContent, stableString, type AutoScopes, type AutoScopesInput, type AutoStatus } from "../shared/automation";
import { portableState } from "../shared/portable";
import { decrypt, decryptLocal, encrypt, encryptLocal } from "./crypto";
import { CredentialStore, secretReferenceSchema } from "./credential-store";
import { Environment, ProviderCaptureError } from "./environment";
import { atomicWrite, digest, readOptional } from "./files";
import { GitHubConflictError, GitHubError, GitHubVault } from "./github";
import { githubLogin, githubToken } from "./login";
import { canRenewClaudeCredential, credentialFreshnessDigest, credentialIdentityDigest, mergeCredentialFreshness, newerCredential, type ProviderCredentialRecord } from "../shared/provider-credentials";
import { asProviders, providerFamily } from "../shared/provider-paths";

type PaseoApi = PluginHandlerContext["paseo"];
export { LEGACY_CLIENT_ID } from "../shared/automation";
const activeRecordSchema = z.object({ version: z.literal(1), enabled: z.literal(true), login: z.string(), secret: secretReferenceSchema, encrypted: z.string() });
const recordSchema = z.discriminatedUnion("enabled", [activeRecordSchema, z.object({ version: z.literal(1), enabled: z.literal(false) })]);
const categoryHashesSchema = z.object({ hosts: z.string(), preferences: z.string(), providers: z.string(), config: z.string(), plugins: z.string() });
const clientFeaturesSchema = z.object({ hostSettings: z.boolean(), preferenceCoverage: z.boolean() });
type ClientFeatures = z.infer<typeof clientFeaturesSchema>;
const legacyClientFeatures: ClientFeatures = { hostSettings: false, preferenceCoverage: false };
function clientFeatures(client: ClientState): ClientFeatures {
  return { hostSettings: client.hostSettings !== undefined, preferenceCoverage: client.preferenceCoverage !== undefined };
}
function featureClient(client: ClientState, features: ClientFeatures): ClientState {
  const { hostSettings, preferenceCoverage, ...legacy } = client;
  const preferences = !features.preferenceCoverage && preferenceCoverage ? Object.fromEntries(Object.entries(client.preferences).filter(([key]) => (legacyPreferenceKeys as readonly string[]).includes(key))) : client.preferences;
  return { ...legacy, preferences, ...(features.hostSettings && hostSettings ? { hostSettings } : {}), ...(features.preferenceCoverage && preferenceCoverage ? { preferenceCoverage } : {}) };
}
const stateSchema = z.object({
  scopes: autoScopesInputSchema, lastRevision: z.string().nullable(), lastSyncedAt: z.string().nullable(),
  ownerClientId: z.string().uuid().nullable().default(null),
  deferredProviders: z.boolean().optional(),
  reconcileScopes: autoScopesSchema.optional(),
  baseline: z.object({ server: z.string(), client: z.string(), categories: categoryHashesSchema.optional(), clientFeatures: clientFeaturesSchema.optional(), legacyCategories: z.object({ hosts: z.string(), preferences: z.string() }).optional() }).nullable(),
  pending: z.object({ id: z.string().uuid(), revision: z.string(), snapshot: snapshotSchema, client: clientStateSchema, effectiveScopes: autoScopesSchema.optional(), mergedLocalChanges: z.boolean().optional(), clientFeatures: clientFeaturesSchema.optional(), desiredClientFeatures: clientFeaturesSchema.optional(), beforeClient: z.string(), beforeServer: z.string(), serverDigest: z.string().nullable() }).nullable(),
});
type AutoState = z.infer<typeof stateSchema>;
type ActiveRecord = z.infer<typeof activeRecordSchema>;
type Authority = { login: string; password: string; vault: GitHubVault };
class SyncConflict extends Error {}
function credentialBinding(record: ProviderCredentialRecord, providerIds: string[]) {
  const primary = providerIds.includes(record.vendor) ? record.vendor : [...providerIds].sort()[0];
  return { ...record, providerIds, id: `${record.vendor}-${createHash("sha256").update(primary).digest("hex").slice(0, 24)}` };
}

export class AutoSync {
  private record: ActiveRecord | null = null;
  private state: AutoState | null = null;
  private password: string | null = null;
  private vault: GitHubVault | null = null;
  private phase: AutoStatus["state"] = "off";
  private message = offStatus.message;
  private runtimeScopes: AutoScopes | null = null;
  private readonly file: string;
  constructor(private environment = new Environment(), private credentials = new CredentialStore(), private vaultFactory = (token: string) => new GitHubVault(token), private token = githubToken, private identity = githubLogin) {
    this.file = path.join(environment.home, "settings-sync", "automation.json");
  }
  private scopes() { return this.runtimeScopes ?? this.state!.scopes; }
  private hashes(snapshot: Snapshot, scopes = this.scopes(), features = clientFeatures(selectClient(snapshot.client, scopes))) {
    const client = featureClient(selectClient(snapshot.client, scopes), features);
    const config = selectConfig(snapshot.config, scopes);
    const contentClient = clientContent(client);
    const legacy = clientContent(featureClient(client, legacyClientFeatures));
    const categories = {
      hosts: digest(stableString(client.hostSettings ? { hosts: contentClient.hosts, hostSettings: client.hostSettings } : contentClient.hosts)),
      preferences: digest(stableString(client.preferenceCoverage ? { preferences: client.preferences, preferenceCoverage: contentClient.preferenceCoverage } : client.preferences)),
      providers: digest(stableString(scopes.providers && snapshot.credentials?.records.length ? { providers: config.providers ?? {}, credentials: credentialIdentityDigest(snapshot.credentials) } : config.providers ?? {})),
      config: digest(stableString(selectConfig(config, { ...scopes, providers: false }))),
      plugins: digest(stableString(serverContent(snapshot, { ...scopes, config: false, providers: false }).plugins)),
    };
    const { credentials: _credentials, ...content } = serverContent(snapshot, scopes);
    if (!scopes.providers && this.state?.scopes.providers && this.state.deferredProviders && this.state.baseline?.categories) categories.providers = this.state.baseline.categories.providers;
    return { server: digest(stableString({ ...content, ...(scopes.providers && snapshot.credentials?.records.length ? { credentials: credentialIdentityDigest(snapshot.credentials) } : {}) })), client: digest(stableString(contentClient)), categories, clientFeatures: features, legacyCategories: { hosts: digest(stableString(legacy.hosts)), preferences: digest(stableString(legacy.preferences)) } };
  }
  private async capture(paseo: PaseoApi, client: ClientState, scopes = this.scopes()) {
    const snapshot = await this.environment.capture(paseo, selectClient(client, scopes), scopes);
    return filterSnapshot(snapshot, scopes);
  }
  private active(scopes = this.state!.scopes) {
    return Object.values(scopes).some(Boolean);
  }
  private pendingScopes() {
    return this.state!.pending!.effectiveScopes ?? availableScopes(this.state!.pending!.snapshot, this.scopes());
  }
  private changed(snapshot: Snapshot) {
    const baseline = this.state!.baseline;
    if (!baseline) return false;
    return this.differs(snapshot, this.scopes());
  }
  private differs(snapshot: Snapshot, effective: AutoScopes) {
    const baseline = this.state!.baseline!;
    const previous = baseline.clientFeatures ?? legacyClientFeatures;
    const present = clientFeatures(snapshot.client);
    const features = { hostSettings: previous.hostSettings && present.hostSettings, preferenceCoverage: previous.preferenceCoverage && present.preferenceCoverage };
    const hashes = this.hashes(snapshot, effective, features);
    if (baseline.categories) {
      return (Object.keys(effective) as (keyof AutoScopes)[]).some((key) => {
        if (!effective[key]) return false;
        const expected = key === "hosts" && previous.hostSettings && !features.hostSettings ? baseline.legacyCategories?.hosts : key === "preferences" && previous.preferenceCoverage && !features.preferenceCoverage ? baseline.legacyCategories?.preferences : baseline.categories![key];
        return expected !== undefined && hashes.categories[key] !== expected;
      });
    }
    return hashes.server !== baseline.server || hashes.client !== baseline.client;
  }
  private remoteChanged(snapshot: Snapshot) {
    const baseline = this.state!.baseline;
    if (!baseline) return true;
    const effective = availableScopes(snapshot, this.scopes());
    return this.differs(snapshot, effective);
  }
  private async save() {
    const encrypted = await encryptLocal(this.state, this.password!);
    await atomicWrite(this.file, JSON.stringify({ ...this.record!, encrypted }));
  }
  private async load(authenticate = true) {
    if (!this.record || !this.state || !this.password) {
      const raw = await readOptional(this.file);
      if (!raw) return;
      const record = recordSchema.parse(JSON.parse(raw));
      if (!record.enabled) return;
      this.record = record;
      const password = await this.credentials.reveal(record.secret);
      this.state = stateSchema.parse(await decryptLocal(record.encrypted, password));
      this.password = password;
      this.phase = this.state.pending ? "syncing" : "ready";
      this.message = this.state.pending ? "중단된 복원 작업을 이어서 확인합니다." : "자동 동기화가 연결되었습니다.";
    }
    if (authenticate && !this.vault) {
      const token = await this.token();
      if (!token) throw new Error("GitHub에 다시 로그인한 뒤 자동 동기화를 연결하세요.");
      if ((await this.identity(token)).toLowerCase() !== this.record.login.toLowerCase()) throw new Error("GitHub 계정이 변경되었습니다. 저장된 동기화 계정으로 다시 로그인하세요.");
      this.vault = this.vaultFactory(token);
    }
  }
  private view(): AutoStatus {
    const message = this.phase === "ready" && this.state?.deferredProviders && this.state.scopes.providers ? "프로바이더 인증은 대기 중입니다. 호스트·앱 설정·서버 설정·플러그인 중 선택한 항목은 동기화하며, 기존 로컬·클라우드 인증은 보존합니다." : this.message;
    return { enabled: Boolean(this.record), login: this.record?.login ?? null, state: this.phase, lastSyncedAt: this.state?.lastSyncedAt ?? null, message, scopes: this.state?.scopes ?? offStatus.scopes, pendingOperations: this.state ? Number(Boolean(this.state.pending)) : this.record ? null : 0, ownerClientId: this.state?.ownerClientId ?? null };
  }
  async status() {
    try { await this.load(false); if (this.state && this.active()) await this.load(); }
    catch { this.phase = "locked"; this.message = "보관한 키나 GitHub 인증을 사용할 수 없습니다. OS 키링 잠금과 GitHub 계정을 확인하거나 다시 연결하세요."; }
    return this.view();
  }
  async enable(authority: Authority, scopes: AutoScopesInput, clientId = LEGACY_CLIENT_ID) {
    const ownerClientId = z.string().uuid().parse(clientId);
    const secret = await this.credentials.protect(authority.password);
    const state: AutoState = { scopes: normalizeScopes(scopes), lastRevision: null, lastSyncedAt: null, baseline: null, pending: null, ownerClientId };
    const encrypted = await encryptLocal(state, authority.password);
    const record: ActiveRecord = { version: 1, enabled: true, login: authority.login, secret, encrypted };
    try { await atomicWrite(this.file, JSON.stringify(record)); }
    catch (error) { await this.credentials.remove(secret); throw error; }
    const previous = this.record?.secret;
    this.record = record; this.state = state; this.password = authority.password; this.vault = authority.vault;
    this.phase = "ready"; this.message = "자동 동기화를 시작합니다. 기존 백업이 있으면 먼저 가져옵니다.";
    if (previous) await this.credentials.remove(previous);
    return this.view();
  }
  async claim(clientId: string) {
    await this.load();
    if (!this.record || !this.state) throw new Error("자동 동기화를 먼저 연결하세요.");
    const owner = z.string().uuid().parse(clientId);
    if (owner !== this.state.ownerClientId) {
      const previous = this.state.ownerClientId;
      this.state.ownerClientId = owner;
      try { await this.save(); }
      catch (error) { this.state.ownerClientId = previous; throw error; }
    }
    return this.view();
  }
  async configure(scopes: AutoScopesInput, client: ClientState, paseo: PaseoApi, clientId = LEGACY_CLIENT_ID, takeover?: { expectedOwnerClientId: string | null }) {
    await this.load(false);
    const ownerClientId = z.string().uuid().parse(clientId);
    if (!this.record || !this.state) throw new Error("자동 동기화를 먼저 연결하세요.");
    const ownerChanged = this.state.ownerClientId !== ownerClientId;
    if (takeover) {
      const expected = z.string().uuid().nullable().parse(takeover.expectedOwnerClientId);
      if (this.state.ownerClientId !== expected) throw new Error("동기화 담당 앱이 변경되었습니다. 현재 상태를 확인한 뒤 다시 적용하세요.");
    } else if (!this.state.ownerClientId || ownerChanged) throw new Error("이 앱은 자동 동기화 담당이 아닙니다. 먼저 이 앱으로 인계하세요.");
    if (this.state.pending) throw new Error("진행 중인 복원을 먼저 완료한 뒤 동기화 항목을 변경하세요.");
    const selected = normalizeScopes(scopes);
    if (!ownerChanged && stableString(selected) === stableString(this.state.scopes)) return this.view();
    const retained = Object.fromEntries(Object.entries(selected).map(([key, enabled]) => [key, enabled && this.state!.scopes[key as keyof AutoScopes] && !(ownerChanged && (key === "hosts" || key === "preferences"))])) as AutoScopes;
    const baseline = this.state.baseline;
    if (baseline && this.active(retained) && !baseline.categories) throw new Error("동기화 항목을 변경하기 전에 기존 동기화를 한 번 완료하세요. 모든 항목을 끄는 것은 가능합니다.");
    const current = this.active(selected) ? await this.capture(paseo, client, selected) : { version: 1 as const, createdAt: new Date().toISOString(), device: "", client: { hosts: [], preferences: {} }, config: {}, plugins: [], scopes: selected };
    if (baseline?.categories) {
      if (this.differs(current, retained)) throw new Error("계속 동기화할 항목에 아직 전송하지 않은 변경이 있습니다. 먼저 동기화를 완료하세요.");
    }
    const previous = this.state;
    const reconcileScopes = Object.fromEntries(Object.entries(selected).map(([key, enabled]) => [key, enabled && (previous.baseline === null || !previous.scopes[key as keyof AutoScopes] || Boolean(previous.reconcileScopes?.[key as keyof AutoScopes]) || ownerChanged && (key === "hosts" || key === "preferences"))])) as AutoScopes;
    this.state = { ...previous, ownerClientId, scopes: selected, baseline: this.hashes(current, selected), lastRevision: null, reconcileScopes };
    try { await this.save(); }
    catch (error) { this.state = previous; throw error; }
    this.phase = "ready"; this.message = "동기화 항목을 저장했습니다. 선택한 항목의 클라우드 설정을 먼저 확인합니다.";
    return this.view();
  }
  async disable() {
    const raw = await readOptional(this.file);
    const saved = raw ? recordSchema.parse(JSON.parse(raw)) : null;
    const reference = this.record?.secret ?? (saved?.enabled ? saved.secret : null);
    await atomicWrite(this.file, JSON.stringify({ version: 1, enabled: false }));
    this.record = null; this.state = null; this.password = null; this.vault = null; this.phase = "off"; this.message = "자동 동기화 연결을 해제했습니다.";
    if (reference) {
      try { await this.credentials.remove(reference); }
      catch { this.message = "자동 동기화는 해제했습니다. OS 키링에 남은 Paseo Settings Sync 항목은 키링에서 삭제할 수 있습니다."; }
    }
    return this.view();
  }
  private publication(snapshot: Snapshot, remote: Snapshot | null) {
    if (!this.scopes().providers || !remote?.credentials) return snapshot;
    const providers = asProviders(snapshot.config.providers);
    const localRecords = new Map(snapshot.credentials?.records.map((record) => [record.id, record]));
    const retainedClaude = remote.credentials.records.flatMap((record) => {
      if (record.vendor !== "claude") return [];
      const providerIds = record.providerIds.filter((id) => id in providers && providerFamily(id, providers) === "claude");
      if (!providerIds.length) return [];
      const local = localRecords.get(record.id);
      if (providerIds.length === record.providerIds.length && local?.identity === record.identity && stableString([...local.providerIds].sort()) === stableString([...providerIds].sort())) return [];
      let retained = credentialBinding(record, providerIds);
      for (const candidate of snapshot.credentials?.records ?? []) {
        if (candidate.vendor === "claude" && candidate.identity === retained.identity && candidate.providerIds.some((id) => providerIds.includes(id))) retained = newerCredential(candidate, retained);
      }
      return [retained];
    });
    if (!retainedClaude.length) return snapshot;
    const covered = new Set(retainedClaude.flatMap((record) => record.providerIds));
    const accountIds = new Set(retainedClaude.flatMap((record) => record.metadata.accounts?.map((account) => account.id) ?? []));
    const records = (snapshot.credentials?.records ?? []).flatMap((record) => {
      const providerIds = record.providerIds.filter((id) => !covered.has(id));
      if (!providerIds.length) return [];
      const bound = providerIds.length === record.providerIds.length ? record : credentialBinding(record, providerIds);
      if (!bound.metadata.accounts?.some((account) => accountIds.has(account.id))) return [bound];
      const { accounts: previousAccounts, ...metadata } = bound.metadata;
      const accounts = previousAccounts!.filter((account) => !accountIds.has(account.id));
      return [{ ...bound, metadata: { ...metadata, ...(accounts.length ? { accounts } : {}) } }];
    });
    return { ...snapshot, credentials: { version: 1 as const, records: [...records, ...retainedClaude] } };
  }
  private async publish(snapshot: Snapshot, revision: string | null, remote: Snapshot | null, baseline = snapshot, resolveConflicts = false) {
    if (!resolveConflicts) snapshot = this.publication(snapshot, remote);
    if (this.scopes().providers && snapshot.credentials && remote?.credentials) snapshot = { ...snapshot, credentials: mergeCredentialFreshness(remote.credentials, snapshot.credentials) };
    const sha = await this.vault!.write(await encrypt(mergeSnapshot(remote, snapshot, this.scopes()), this.password!), revision, resolveConflicts);
    this.state!.lastRevision = sha; this.state!.baseline = this.hashes(baseline); this.state!.pending = null;
    delete this.state!.reconcileScopes;
    this.state!.lastSyncedAt = new Date().toISOString();
    await this.save();
    this.phase = "ready"; this.message = "설정 변경을 암호화해 자동 백업했습니다.";
  }
  private async begin(snapshot: Snapshot, revision: string, current: Snapshot, paseo: PaseoApi, clientId: string, mergedLocalChanges = false) {
    const effectiveScopes = availableScopes(snapshot, this.scopes());
    const hashes = this.hashes(current, effectiveScopes);
    const client = selectClient(this.state!.baseline ? replacePortableClient(current.client, snapshot.client) : mergeClients(current.client, snapshot.client), effectiveScopes);
    this.state!.pending = { id: randomUUID(), revision, snapshot, client: portableState(client), effectiveScopes, ...(mergedLocalChanges ? { mergedLocalChanges: true } : {}), clientFeatures: hashes.clientFeatures, desiredClientFeatures: clientFeatures(client), beforeClient: hashes.client, beforeServer: hashes.server, serverDigest: null };
    await this.save();
    return this.applyPending(current, paseo, clientId);
  }
  private async applyPending(current: Snapshot, paseo: PaseoApi, clientId: string) {
    const pending = this.state!.pending!;
    const effective = this.pendingScopes();
    const hashes = this.hashes(current, effective, pending.clientFeatures ?? legacyClientFeatures);
    const desiredFeatures = pending.desiredClientFeatures ?? legacyClientFeatures;
    const desiredClient = digest(stableString(clientContent(featureClient(selectClient(pending.client, effective), desiredFeatures))));
    const actualClient = this.hashes(current, effective, desiredFeatures).client;
    if (hashes.client !== pending.beforeClient && actualClient !== desiredClient) throw new SyncConflict("자동 복원 중 앱 설정이 바뀌었습니다. 사용할 환경을 선택하세요.");
    if (pending.serverDigest === null) {
      if (hashes.server !== pending.beforeServer) throw new SyncConflict("이전 복원 도중 서버 설정이 바뀌었습니다. 사용할 환경을 선택하세요.");
      if (effective.providers || effective.config || effective.plugins) {
        const snapshot = filterSnapshot(pending.snapshot, effective);
        const fingerprint = await this.environment.fingerprint(paseo, snapshot);
        await this.environment.restore(paseo, snapshot, fingerprint, { ...effective, merge: this.state!.baseline === null, preserveLocalClaude: true });
      }
      pending.serverDigest = this.hashes(await this.capture(paseo, current.client), effective).server;
      await this.save();
    } else if (hashes.server !== pending.serverDigest) throw new SyncConflict("자동 복원 이후 서버 설정이 바뀌었습니다. 사용할 환경을 선택하세요.");
    if (actualClient === desiredClient) {
      await this.completePending(await this.capture(paseo, current.client), pending, clientId);
      return { status: this.view(), operation: null };
    }
    this.phase = "syncing"; this.message = "저장된 설정을 자동 복원하고 있습니다.";
    return { status: this.view(), operation: { id: pending.id, client: pending.client, scopes: effective } };
  }
  async tick(client: ClientState, paseo: PaseoApi, force?: "local" | "remote", clientId = LEGACY_CLIENT_ID) {
    this.runtimeScopes = null;
    try {
      await this.load(false);
      if (!this.record) return { status: this.view(), operation: null };
      if (!this.state!.ownerClientId || this.state!.ownerClientId !== clientId) return { status: this.view(), operation: null };
      if (!this.active()) { this.phase = "ready"; this.message = "모든 동기화 항목이 꺼져 있습니다."; return { status: this.view(), operation: null }; }
      await this.load();
      if (this.state!.deferredProviders && this.state!.pending?.effectiveScopes?.providers === false) this.runtimeScopes = { ...this.state!.scopes, providers: false };
      let current: Snapshot;
      try { current = await this.capture(paseo, client); }
      catch (error) {
        const remaining = { ...this.state!.scopes, providers: false };
        if (!(error instanceof ProviderCaptureError) || !this.scopes().providers || !this.active(remaining) || this.state!.pending && this.pendingScopes().providers) throw error;
        this.runtimeScopes = remaining;
        current = await this.capture(paseo, client);
        this.state!.deferredProviders = true;
        await this.save();
      }
      if (this.scopes().providers && this.state!.deferredProviders) {
        this.state!.lastRevision = null;
        delete this.state!.deferredProviders;
      }
      const remote = await this.vault!.read();
      if (remote.conflicts && !force) throw new SyncConflict(new GitHubConflictError().message);
      const incoming = remote.raw ? await decrypt(remote.raw, this.password!) : null;
      if (remote.conflicts && force === "remote") remote.sha = await this.vault!.write(remote.raw!, remote.sha, true);
      if (this.state!.pending && !force) {
        if (remote.sha !== this.state!.pending.revision) throw new SyncConflict("복원 도중 다른 기기의 백업이 바뀌었습니다. 사용할 환경을 선택하세요.");
        return await this.applyPending(current, paseo, clientId);
      }
      if (this.scopes().providers && current.credentials && incoming?.credentials && credentialIdentityDigest(current.credentials) === credentialIdentityDigest(incoming.credentials)) {
        const credentials = mergeCredentialFreshness(current.credentials, incoming.credentials);
        const localClaude = new Map(current.credentials.records.filter((record) => record.vendor === "claude").map((record) => [record.id, record]));
        credentials.records = credentials.records.map((record) => record.vendor === "claude" && !canRenewClaudeCredential(localClaude.get(record.id), record) ? localClaude.get(record.id) ?? record : record);
        if (credentialFreshnessDigest(credentials) !== credentialFreshnessDigest(current.credentials)) {
          const refreshed = { ...current, credentials, plugins: [] };
          await this.environment.restore(paseo, refreshed, await this.environment.fingerprint(paseo, refreshed), { providers: true, config: false, plugins: false, merge: false, preserveLocalClaude: true });
          current = await this.capture(paseo, client);
        }
      }
      if (force === "local") { await this.publish(current, remote.sha, incoming, current, true); return { status: this.view(), operation: null }; }
      if (force === "remote") {
        if (!remote.raw || !remote.sha) throw new SyncConflict("가져올 백업이 없습니다. 이 PC의 환경으로 동기화하세요.");
        return await this.begin(incoming!, remote.sha, current, paseo, clientId);
      }
      if (this.state!.baseline && incoming && remote.sha !== this.state!.lastRevision) {
        const previous = this.state!.baseline.clientFeatures ?? legacyClientFeatures;
        const localFeatures = clientFeatures(current.client);
        const remoteFeatures = clientFeatures(incoming.client);
        const effective = availableScopes(incoming, this.scopes());
        const local = this.hashes(current, effective).categories;
        const saved = this.hashes(incoming, effective).categories;
        if ((effective.hosts && !previous.hostSettings && localFeatures.hostSettings && remoteFeatures.hostSettings && local.hosts !== saved.hosts) || (effective.preferences && !previous.preferenceCoverage && localFeatures.preferenceCoverage && remoteFeatures.preferenceCoverage && local.preferences !== saved.preferences)) throw new SyncConflict("새로 동기화하는 호스트 표시·앱 설정이 다른 기기와 다릅니다. 사용할 환경을 선택하세요.");
      }
      if (incoming && this.state!.reconcileScopes) {
        const effective = availableScopes(incoming, this.state!.reconcileScopes);
        const local = this.hashes(current, effective).categories;
        const saved = this.hashes(incoming, effective).categories;
        if ((Object.keys(effective) as (keyof AutoScopes)[]).some((key) => effective[key] && local[key] !== saved[key])) {
          throw new SyncConflict("새로 선택한 동기화 항목의 이 PC 설정과 클라우드 설정이 다릅니다. ‘이 PC 사용’ 또는 ‘클라우드 사용’을 한 번 선택하세요.");
        }
      }
      const changed = this.changed(current);
      const features = clientFeatures(current.client);
      const previousFeatures = this.state!.baseline?.clientFeatures ?? legacyClientFeatures;
      const upgradedClient = features.hostSettings && !previousFeatures.hostSettings || features.preferenceCoverage && !previousFeatures.preferenceCoverage;
      const remoteChanged = remote.sha !== this.state!.lastRevision;
      const remoteDataChanged = remoteChanged && incoming && this.remoteChanged(incoming);
      const refreshedAuthentication = this.scopes().providers && current.credentials && incoming?.credentials && credentialIdentityDigest(current.credentials) === credentialIdentityDigest(incoming.credentials) && credentialFreshnessDigest(mergeCredentialFreshness(incoming.credentials, current.credentials)) !== credentialFreshnessDigest(incoming.credentials);
      if (this.state!.baseline && remoteDataChanged && changed) {
        if (!this.state!.baseline.categories) throw new SyncConflict("이 PC와 다른 기기에서 설정이 함께 바뀌었습니다. 사용할 환경을 선택하세요.");
        const effective = availableScopes(incoming!, this.scopes());
        const local = this.hashes(current, effective).categories, saved = this.hashes(incoming!, effective).categories;
        const changedHere = Object.fromEntries((Object.keys(effective) as (keyof AutoScopes)[]).map(key => [key, effective[key] && this.differs(current, { ...normalizeScopes({ config: false, plugins: false, hosts: false, preferences: false, providers: false }), [key]: true })])) as AutoScopes;
        const conflict = (Object.keys(effective) as (keyof AutoScopes)[]).some(key => changedHere[key] && this.differs(incoming!, { ...normalizeScopes({ config: false, plugins: false, hosts: false, preferences: false, providers: false }), [key]: true }) && local[key] !== saved[key]);
        if (conflict) throw new SyncConflict("이 PC와 다른 기기에서 같은 동기화 항목이 다르게 바뀌었습니다. 사용할 환경을 선택하세요.");
        return await this.begin(mergeSnapshot(incoming!, current, changedHere), remote.sha!, current, paseo, clientId, true);
      }
      if (this.state!.baseline && remoteChanged && !remoteDataChanged && !changed && incoming?.credentials?.records.length && remote.sha) {
        if (refreshedAuthentication || upgradedClient) await this.publish(current, remote.sha, incoming);
        else {
          this.state!.lastRevision = remote.sha; this.state!.baseline = this.hashes(current); this.state!.lastSyncedAt = new Date().toISOString();
          await this.save(); this.phase = "ready"; this.message = "프로바이더 인증을 최신 상태로 동기화했습니다.";
        }
        return { status: this.view(), operation: null };
      }
      if (this.state!.baseline && remoteChanged && !remoteDataChanged && incoming && changed) {
        await this.publish(current, remote.sha, incoming); return { status: this.view(), operation: null };
      }
      if ((!this.state!.baseline || remoteChanged) && remote.raw && remote.sha) {
        if (!this.state!.baseline && availableScopes(incoming!, this.scopes()).plugins && current.plugins.some((local) => incoming!.plugins.some((saved) => saved.id === local.id && stableString(saved.files) !== stableString(local.files)))) {
          throw new SyncConflict("처음 연결한 이 PC와 백업의 플러그인 코드가 다릅니다. 개발·원본 PC라면 ‘이 PC 사용’, 저장된 버전을 받을 PC라면 ‘클라우드 사용’을 한 번 선택하세요.");
        }
        return await this.begin(incoming!, remote.sha, current, paseo, clientId);
      }
      if (this.state!.baseline && remoteChanged) throw new SyncConflict("백업이 삭제되거나 이동했습니다. 이 PC의 환경으로 다시 백업할지 선택하세요.");
      if (!this.state!.baseline || changed || refreshedAuthentication || upgradedClient) await this.publish(current, remote.sha, incoming);
      else {
        if (!this.state!.baseline.categories) { this.state!.baseline = this.hashes(current); await this.save(); }
        this.phase = "ready"; this.message = "모든 설정이 최신입니다. 앱을 사용하는 동안 변경을 자동 동기화합니다.";
      }
      return { status: this.view(), operation: null };
    } catch (error) {
      this.phase = error instanceof SyncConflict || error instanceof GitHubConflictError ? "conflict" : "error";
      this.message = error instanceof Error ? error.message : "자동 동기화에 실패했습니다. 잠시 후 다시 시도합니다.";
      if (error instanceof GitHubError && error.status === 401) this.vault = null;
      return { status: this.view(), operation: null };
    } finally { this.runtimeScopes = null; }
  }
  async acknowledge(operationId: string, client: ClientState, paseo: PaseoApi, clientId = LEGACY_CLIENT_ID) {
    await this.load(false);
    if (!this.state?.ownerClientId || this.state.ownerClientId !== clientId) throw new Error("이 앱은 자동 동기화 담당이 아닙니다. 설정에서 이 앱으로 인계한 뒤 다시 시도하세요.");
    await this.load();
    const pending = this.state?.pending;
    if (!pending || pending.id !== operationId) throw new Error("자동 복원 작업이 만료되었습니다. 다시 동기화하세요.");
    if (this.state!.deferredProviders && pending.effectiveScopes?.providers === false) this.runtimeScopes = { ...this.state!.scopes, providers: false };
    try {
      const current = await this.capture(paseo, client);
      return await this.completePending(current, pending, clientId);
    } finally { this.runtimeScopes = null; }
  }
  private async completePending(current: Snapshot, pending: NonNullable<AutoState["pending"]>, clientId: string) {
    const authorized = () => this.state?.ownerClientId === clientId && this.state?.pending?.id === pending.id;
    if (!authorized()) throw new SyncConflict("자동 동기화 담당 앱이나 복원 작업이 변경되었습니다. 다시 동기화하세요.");
    const features = pending.desiredClientFeatures ?? legacyClientFeatures;
    const hashes = this.hashes(current, this.pendingScopes(), features);
    if (hashes.client !== digest(stableString(clientContent(featureClient(selectClient(pending.client, this.pendingScopes()), features)))) || hashes.server !== pending.serverDigest) throw new SyncConflict("복원 결과가 변경되었습니다. 다시 동기화하세요.");
    const remote = await this.vault!.read();
    if (remote.conflicts || remote.sha !== pending.revision) throw new SyncConflict("복원 중 백업이 바뀌었습니다. 다시 동기화하세요.");
    if (!authorized()) throw new SyncConflict("자동 동기화 담당 앱이나 복원 작업이 변경되었습니다. 다시 동기화하세요.");
    const publication = this.publication(current, pending.snapshot);
    const outgoing = mergeSnapshot(pending.snapshot, publication, this.scopes());
    const all = normalizeScopes({ config: true, plugins: true });
    const content = (snapshot: Snapshot) => {
      const { credentials, ...server } = serverContent(snapshot, all);
      return { ...server, ...(credentials ? { credentials: credentialFreshnessDigest(credentials) } : {}), client: clientContent(snapshot.client), scopes: availableScopes(snapshot, all) };
    };
    if (pending.mergedLocalChanges || stableString(content(outgoing)) !== stableString(content(pending.snapshot))) {
      await this.publish(publication, pending.revision, pending.snapshot, current);
    } else {
      this.state!.lastRevision = pending.revision; this.state!.baseline = this.hashes(current); this.state!.pending = null; this.state!.lastSyncedAt = new Date().toISOString();
      delete this.state!.reconcileScopes;
      await this.save(); this.phase = "ready"; this.message = "저장된 설정을 자동 복원했습니다. 호스트·화면이 바뀌면 앱 창을 새로고침합니다.";
    }
    return this.view();
  }
  dispose() { this.password = null; this.vault = null; this.state = null; this.record = null; }
}
