import { z } from "zod";
import { scopeFlagsSchema, pickConfig, jsonObject, legacyPreferenceKeys, type ClientState, type Snapshot } from "./model";
import { portableState } from "./portable";
import { projectProviders } from "./provider-paths";
import { applyHostSettings, mergeHostSettings, type HostSettings } from "./host-settings";

export const autoScopesSchema = scopeFlagsSchema;
export type AutoScopesInput = { config: boolean; plugins: boolean; hosts?: boolean; preferences?: boolean; providers?: boolean };
export function normalizeScopes(scopes: AutoScopesInput): AutoScopes {
  return { hosts: scopes.hosts ?? true, preferences: scopes.preferences ?? true, providers: scopes.providers ?? scopes.config, config: scopes.config, plugins: scopes.plugins };
}
export const autoScopesInputSchema = z.object({
  config: z.boolean(), plugins: z.boolean(), hosts: z.boolean().optional(), preferences: z.boolean().optional(), providers: z.boolean().optional(),
}).transform(normalizeScopes);
export const LEGACY_CLIENT_ID = "00000000-0000-4000-8000-000000000000";
export const autoStatusSchema = z.object({
  enabled: z.boolean(), login: z.string().nullable(),
  state: z.enum(["off", "ready", "syncing", "conflict", "error", "locked"]),
  lastSyncedAt: z.string().nullable(), message: z.string(), scopes: autoScopesSchema,
  pendingOperations: z.number().int().nonnegative().nullable(),
  ownerClientId: z.string().uuid().nullable(),
});
export type AutoStatus = z.infer<typeof autoStatusSchema>;
export type AutoScopes = z.infer<typeof autoScopesSchema>;
export const offStatus: AutoStatus = { enabled: false, login: null, state: "off", lastSyncedAt: null, message: "자동 동기화를 연결하세요.", scopes: normalizeScopes({ config: true, plugins: true }), pendingOperations: 0, ownerClientId: null };

export function stableString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stableString(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function legacyHostSettings(current: HostSettings | undefined, hosts: ClientState["hosts"], merge = false): HostSettings | undefined {
  if (!current) return undefined;
  const incoming = new Map(hosts.map((host) => [host.serverId, {
    serverId: host.serverId,
    ...(host.label === undefined ? {} : { label: host.label }),
    ...(host.appearance === undefined ? {} : { appearance: host.appearance }),
  }]));
  const presentation = current.hosts.map((host) => {
    const provided = incoming.get(host.serverId);
    incoming.delete(host.serverId);
    if (!provided) return host;
    if (merge) return { ...host, ...provided };
    const { label: _label, appearance: _appearance, ...identity } = host;
    return { ...identity, ...provided };
  });
  return { ...current, hosts: [...presentation, ...incoming.values()] };
}

export function mergeClients(current: ClientState, incoming: ClientState): ClientState {
  const hosts = [...current.hosts];
  for (const host of incoming.hosts) {
    const index = hosts.findIndex((entry) => entry.serverId === host.serverId);
    if (index < 0) hosts.push(host);
    else {
      const local = hosts[index];
      const connections = [...local.connections.filter((entry) => !host.connections.some((item) => item.id === entry.id)), ...host.connections];
      hosts[index] = { ...local, ...host, connections };
    }
  }
  const hostSettings = incoming.hostSettings ? mergeHostSettings(current.hostSettings, incoming.hostSettings) : legacyHostSettings(current.hostSettings, incoming.hosts, true);
  return {
    hosts: hostSettings ? applyHostSettings(hosts, hostSettings) : hosts,
    preferences: { ...current.preferences, ...incoming.preferences },
    ...(hostSettings ? { hostSettings } : {}),
    ...(current.localHostIds ? { localHostIds: current.localHostIds } : {}),
    ...(current.preferenceCoverage || incoming.preferenceCoverage ? { preferenceCoverage: [...new Set([...preferenceCoverage(current), ...preferenceCoverage(incoming)])].sort() } : {}),
  };
}

export function preferenceCoverage(client: ClientState): string[] {
  return client.preferenceCoverage ?? [...new Set<string>([...legacyPreferenceKeys, ...Object.keys(client.preferences)])];
}

function replacePreferences(current: ClientState, incoming: ClientState) {
  const covered = new Set(preferenceCoverage(incoming));
  return {
    preferences: { ...Object.fromEntries(Object.entries(current.preferences).filter(([key]) => !covered.has(key))), ...incoming.preferences },
    ...(current.preferenceCoverage || incoming.preferenceCoverage ? { preferenceCoverage: [...new Set([...preferenceCoverage(current), ...covered])].sort() } : {}),
  };
}

export function replacePortableClient(current: ClientState, incoming: ClientState): ClientState {
  const desired = portableState(incoming);
  const saved = new Map(desired.hosts.map((host) => [host.serverId, host]));
  const metadataIds = new Set(desired.hostSettings?.hosts.map((host) => host.serverId));
  const portable = new Map(portableState(current).hosts.map((host) => [host.serverId, host]));
  const hosts = current.hosts.flatMap((host) => {
    if (host.serverId.startsWith("local:")) return [host];
    const incomingHost = saved.get(host.serverId);
    saved.delete(host.serverId);
    if (!incomingHost && metadataIds.has(host.serverId)) return [host];
    const portableIds = new Set(portable.get(host.serverId)?.connections.map((connection) => connection.id));
    const localConnections = host.connections.filter((connection) => !portableIds.has(connection.id));
    if (incomingHost) {
      const connections = [...localConnections.filter((connection) => !incomingHost.connections.some((item) => item.id === connection.id)), ...incomingHost.connections];
      return [{ ...incomingHost, connections }];
    }
    if (!localConnections.length) return [];
    const preferredConnectionId = localConnections.some((connection) => connection.id === host.preferredConnectionId) ? host.preferredConnectionId : String(localConnections[0].id);
    return [{ ...host, connections: localConnections, preferredConnectionId }];
  });
  const combined = [...hosts, ...saved.values()];
  const presentation = desired.hostSettings ?? legacyHostSettings(current.hostSettings, desired.hosts);
  const providedIds = new Set(presentation?.hosts.map((host) => host.serverId));
  const localIds = new Set(current.localHostIds);
  const retained = new Map(current.hostSettings?.hosts.filter((host) => localIds.has(host.serverId) && !providedIds.has(host.serverId)).map((host) => [host.serverId, host]));
  for (const host of combined) if (!providedIds.has(host.serverId)) retained.set(host.serverId, { serverId: host.serverId, ...(host.label === undefined ? {} : { label: host.label }), ...(host.appearance === undefined ? {} : { appearance: host.appearance }) });
  const hostSettings = presentation ? { ...presentation, hosts: [...presentation.hosts, ...retained.values()] } : undefined;
  return { hosts: hostSettings ? applyHostSettings(combined, hostSettings) : combined, ...replacePreferences(current, desired), ...(hostSettings ? { hostSettings } : {}), ...(current.localHostIds ? { localHostIds: current.localHostIds } : {}) };
}

export function selectClient(client: ClientState, input: AutoScopesInput): ClientState {
  const scopes = normalizeScopes(input);
  return {
    hosts: scopes.hosts ? client.hosts : [], preferences: scopes.preferences ? client.preferences : {},
    ...(scopes.hosts && client.hostSettings ? { hostSettings: client.hostSettings } : {}),
    ...(scopes.hosts && client.localHostIds ? { localHostIds: client.localHostIds } : {}),
    ...(scopes.preferences && client.preferenceCoverage ? { preferenceCoverage: client.preferenceCoverage } : {}),
  };
}

export function selectConfig(config: Record<string, unknown>, input: AutoScopesInput, portable = true) {
  const scopes = normalizeScopes(input);
  const selected = Object.fromEntries(Object.entries(pickConfig(config)).filter(([key]) => key === "providers" ? scopes.providers : scopes.config));
  if (portable && selected.providers) selected.providers = projectProviders(selected.providers);
  return jsonObject.parse(selected);
}

export function availableScopes(snapshot: Snapshot, input: AutoScopesInput): AutoScopes {
  const local = normalizeScopes(input);
  const available = snapshot.scopes ?? legacyScopes(snapshot);
  return Object.fromEntries(Object.entries(local).map(([key, enabled]) => [key, enabled && available[key as keyof AutoScopes]])) as AutoScopes;
}

function legacyScopes(snapshot: Snapshot): AutoScopes {
  return { hosts: true, preferences: true, providers: "providers" in snapshot.config, config: Object.keys(pickConfig(snapshot.config)).some((key) => key !== "providers"), plugins: snapshot.plugins.length > 0 };
}

export function filterSnapshot(snapshot: Snapshot, input: AutoScopesInput): Snapshot {
  const scopes = availableScopes(snapshot, input);
  const { credentials, ...rest } = snapshot;
  return { ...rest, client: selectClient(snapshot.client, scopes), config: selectConfig(snapshot.config, scopes), plugins: scopes.plugins ? snapshot.plugins : [], ...(scopes.providers && credentials ? { credentials } : {}), scopes };
}

export function mergeSnapshot(base: Snapshot | null, current: Snapshot, input: AutoScopesInput): Snapshot {
  const scopes = normalizeScopes(input);
  const previous = base?.scopes ?? (base ? legacyScopes(base) : { hosts: false, preferences: false, providers: false, config: false, plugins: false });
  const config = {
    ...selectConfig(base?.config ?? {}, { ...offStatus.scopes, config: !scopes.config, providers: !scopes.providers, plugins: false }),
    ...selectConfig(current.config, scopes),
  };
  const { credentials: _credentials, ...rest } = current;
  const previousClient = base?.client ?? { hosts: [], preferences: {} };
  const hostSettings = scopes.hosts ? current.client.hostSettings ?? legacyHostSettings(previousClient.hostSettings, current.client.hosts) : previousClient.hostSettings;
  const preferences = scopes.preferences ? replacePreferences(previousClient, current.client) : { preferences: previousClient.preferences, ...(previousClient.preferenceCoverage ? { preferenceCoverage: previousClient.preferenceCoverage } : {}) };
  const client = { hosts: scopes.hosts ? current.client.hosts : previousClient.hosts, ...preferences, ...(hostSettings ? { hostSettings } : {}) };
  return {
    ...rest,
    version: Math.max(current.version, base?.version ?? 1, client.hostSettings || client.preferenceCoverage ? 3 : 1) as Snapshot["version"],
    client,
    config, plugins: scopes.plugins ? current.plugins : base?.plugins ?? [],
    scopes: Object.fromEntries(Object.entries(scopes).map(([key, enabled]) => [key, enabled || previous[key as keyof AutoScopes]])) as AutoScopes,
    ...((scopes.providers ? current.credentials : base?.credentials) ? { credentials: scopes.providers ? current.credentials : base?.credentials } : {}),
  };
}

export function serverContent(snapshot: Snapshot, input: AutoScopesInput) {
  const scopes = normalizeScopes(input);
  return { config: selectConfig(snapshot.config, scopes), plugins: scopes.plugins ? [...snapshot.plugins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : [], ...(scopes.providers && snapshot.credentials?.records.length ? { credentials: snapshot.credentials } : {}) };
}

export function clientContent(client: ClientState, scopes: AutoScopesInput = offStatus.scopes) {
  const { localHostIds: _localHostIds, ...selected } = selectClient(client, scopes);
  return { ...selected, hosts: selected.hostSettings ? selected.hosts : [...selected.hosts].sort((a, b) => a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0), ...(selected.preferenceCoverage ? { preferenceCoverage: [...selected.preferenceCoverage].sort() } : {}) };
}
