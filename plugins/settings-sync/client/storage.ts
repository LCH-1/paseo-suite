import { clientStateSchema, legacyPreferenceKeys, preferenceKeys, type ClientState } from "../shared/model";
import { portableState } from "../shared/portable";
import { mergeClients, normalizeScopes, offStatus, replacePortableClient, selectClient, type AutoScopesInput } from "../shared/automation";
import { applyHostSettings, captureHostSettings, hostOrderKey, hostPresentationKey, mergeHostSettings, serializeHostPresentationCache } from "../shared/host-settings";

export const hostKey = "@paseo:daemon-registry";
const sidebarViewKey = "sidebar-view";
const legacySidebarViewKey = "sidebar-group-mode";
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function capture(storage: StorageAdapter, scopes: AutoScopesInput = offStatus.scopes): ClientState {
  const selected = normalizeScopes(scopes);
  const hosts = selected.hosts ? clientStateSchema.shape.hosts.parse(JSON.parse(storage.getItem(hostKey) ?? "[]")) : [];
  const preferences = selected.preferences ? Object.fromEntries(preferenceKeys.flatMap((key) => {
    const stored = storage.getItem(key);
    const value = key === sidebarViewKey && stored === null ? storage.getItem(legacySidebarViewKey) : stored;
    if (value === null) return [];
    return [[key, value]];
  })) : {};
  const state = portableState(clientStateSchema.parse(selectClient({
    hosts, preferences,
    ...(selected.hosts ? { hostSettings: captureHostSettings(hosts, storage.getItem(hostOrderKey), storage.getItem(hostPresentationKey)) } : {}),
    ...(selected.preferences ? { preferenceCoverage: [...preferenceKeys] } : {}),
  }, selected)));
  const portableIds = new Set(state.hosts.map((host) => host.serverId));
  const localHostIds = hosts.filter((host) => !portableIds.has(host.serverId)).map((host) => host.serverId);
  return localHostIds.length ? { ...state, localHostIds } : state;
}

export function restore(storage: StorageAdapter, incoming: ClientState, options: { merge?: boolean; hosts?: boolean; preferences?: boolean } = {}) {
  const state = portableState(clientStateSchema.parse({
    hosts: options.hosts === false ? [] : incoming.hosts,
    preferences: options.preferences === false ? {} : incoming.preferences,
    ...(options.hosts !== false && incoming.hostSettings !== undefined ? { hostSettings: incoming.hostSettings } : {}),
    ...(options.preferences !== false && incoming.preferenceCoverage !== undefined ? { preferenceCoverage: incoming.preferenceCoverage } : {}),
  }));
  const writes: [string, string | null][] = [];
  if (options.hosts !== false) {
    const current = clientStateSchema.shape.hosts.parse(JSON.parse(storage.getItem(hostKey) ?? "[]"));
    const merged = options.merge === false ? replacePortableClient({ hosts: current, preferences: {} }, state) : mergeClients({ hosts: current, preferences: {} }, state);
    const presentation = state.hostSettings === undefined ? undefined : options.merge === false ? merged.hostSettings ?? state.hostSettings : mergeHostSettings(captureHostSettings(current, storage.getItem(hostOrderKey), storage.getItem(hostPresentationKey)), merged.hostSettings ?? state.hostSettings);
    const hosts = presentation === undefined ? merged.hosts : applyHostSettings(merged.hosts, presentation);
    writes.push([hostKey, JSON.stringify(hosts)]);
    if (presentation !== undefined) {
      writes.push([hostOrderKey, presentation.order === null ? null : JSON.stringify(presentation.order)]);
      writes.push([hostPresentationKey, serializeHostPresentationCache(presentation, hosts)]);
    }
  }
  if (options.preferences !== false) {
    const coverage = new Set(state.preferenceCoverage ?? [...legacyPreferenceKeys, ...Object.keys(state.preferences)]);
    const preferences: [string, string | null][] = options.merge === false
      ? preferenceKeys.filter((key) => coverage.has(key)).map((key) => [key, state.preferences[key] ?? null])
      : Object.entries(state.preferences).filter(([key]) => coverage.has(key));
    writes.push(...preferences.map(([key, value]): [string, string | null] => {
      if (key !== "@paseo:app-settings") return [key, value];
      const localRaw = storage.getItem(key);
      let local;
      try { local = JSON.parse(localRaw ?? "{}"); } catch { return [key, value]; }
      if (local?.usage?.serverId === undefined) return [key, value];
      const incoming = JSON.parse(value ?? "{}") ?? {};
      return [key, JSON.stringify({ ...incoming, usage: { ...incoming.usage, serverId: local.usage.serverId } })];
    }));
    if (preferences.some(([key]) => key === sidebarViewKey)) writes.push([legacySidebarViewKey, null]);
  }
  const before = writes.map(([key]) => [key, storage.getItem(key)] as const);
  try { for (const [key, value] of writes) { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } }
  catch (error) {
    for (const [key, value] of before) { if (value === null) storage.removeItem(key); else storage.setItem(key, value); }
    throw error;
  }
  return before;
}

export function browserStorage(): StorageAdapter {
  if (typeof globalThis.localStorage === "undefined") throw new Error("현재 호스트·앱 설정 복원은 Paseo 데스크톱과 웹에서 지원합니다.");
  return globalThis.localStorage;
}
