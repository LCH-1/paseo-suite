import { z } from "zod";

export const hostOrderKey = "@paseo:host-order";
export const hostPresentationKey = "@paseo:settings-sync-host-presentation";

const hostIdsSchema = z.array(z.string().min(1)).max(5000).refine((ids) => new Set(ids).size === ids.length);
const hostPresentationSchema = z.object({
  serverId: z.string().min(1), label: z.string().optional(),
  appearance: z.record(z.string(), z.json()).optional(),
}).strict();

export const hostSettingsSchema = z.object({
  hosts: z.array(hostPresentationSchema).max(5000).refine((hosts) => new Set(hosts.map((host) => host.serverId)).size === hosts.length),
  order: hostIdsSchema.nullable(),
}).strict();

export const hostPresentationCacheSchema = z.object({
  presentation: hostSettingsSchema, knownHostIds: hostIdsSchema,
}).strict();

export type HostSettings = z.infer<typeof hostSettingsSchema>;
type HostPresentation = HostSettings["hosts"][number];

function presentation(host: HostPresentation): HostPresentation {
  return hostPresentationSchema.parse({
    serverId: host.serverId,
    ...(host.label === undefined ? {} : { label: host.label }),
    ...(host.appearance === undefined ? {} : { appearance: host.appearance }),
  });
}

export function captureHostSettings(registry: readonly HostPresentation[], orderRaw: string | null, cacheRaw: string | null): HostSettings {
  const current = registry.map(presentation);
  const currentIds = hostIdsSchema.parse(current.map((host) => host.serverId));
  const known = new Set(currentIds);
  const cache = cacheRaw === null ? { presentation: { hosts: [], order: null }, knownHostIds: [] } : hostPresentationCacheSchema.parse(JSON.parse(cacheRaw));
  const removed = new Set(cache.knownHostIds.filter((id) => !known.has(id)));
  const previous = cache.presentation.hosts.filter((host) => !removed.has(host.serverId));
  const byId = new Map(previous.map((host) => [host.serverId, host]));
  for (const host of current) byId.set(host.serverId, host);
  const previousIds = new Set(cache.knownHostIds);
  const retainedIds = cache.knownHostIds.filter((id) => known.has(id));
  const currentRetainedIds = currentIds.filter((id) => previousIds.has(id));
  const changedOrder = currentRetainedIds.some((id, index) => id !== retainedIds[index]);
  const ids = changedOrder
    ? [...currentIds, ...previous.filter((host) => !known.has(host.serverId)).map((host) => host.serverId)]
    : [...previous.map((host) => host.serverId), ...currentIds.filter((id) => !previous.some((host) => host.serverId === id))];
  const order = orderRaw === null ? null : hostIdsSchema.parse(JSON.parse(orderRaw)).filter((id) => !removed.has(id));
  return hostSettingsSchema.parse({ hosts: ids.map((id) => byId.get(id)!), order });
}

export function applyHostSettings<T extends HostPresentation>(registry: readonly T[], incoming: HostSettings): T[] {
  incoming = hostSettingsSchema.parse(incoming);
  const metadata = new Map(incoming.hosts.map((host) => [host.serverId, host]));
  const hosts = registry.map((host) => {
    const next = metadata.get(host.serverId);
    if (!next) return host;
    const { label: _label, appearance: _appearance, ...connection } = host;
    return { ...connection, ...next } as T;
  });
  const byId = new Map(hosts.map((host) => [host.serverId, host]));
  const sorted = new Set(incoming.hosts.map((host) => host.serverId));
  return incoming.hosts.flatMap((host) => {
    const existing = byId.get(host.serverId);
    return existing ? [existing] : [];
  }).concat(hosts.filter((host) => !sorted.has(host.serverId)));
}

export function mergeHostSettings(current: HostSettings | undefined, incoming: HostSettings | undefined): HostSettings | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return hostSettingsSchema.parse(incoming);
  current = hostSettingsSchema.parse(current);
  incoming = hostSettingsSchema.parse(incoming);
  const incomingIds = new Set(incoming.hosts.map((host) => host.serverId));
  return hostSettingsSchema.parse({ hosts: [...incoming.hosts, ...current.hosts.filter((host) => !incomingIds.has(host.serverId))], order: incoming.order });
}

export function serializeHostPresentationCache(presentation: HostSettings, registry: readonly HostPresentation[]): string {
  return JSON.stringify(hostPresentationCacheSchema.parse({ presentation, knownHostIds: registry.map((host) => host.serverId) }));
}
