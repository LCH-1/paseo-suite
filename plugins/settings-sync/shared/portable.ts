import { z } from "zod";
import { preferenceKeys, type ClientState } from "./model";
import { hostSettingsSchema } from "./host-settings";

const connectionSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("relay"), relayEndpoint: z.string().min(1), useTls: z.boolean().optional(), daemonPublicKeyB64: z.string().min(1) }),
  z.object({ id: z.string().min(1), type: z.literal("directTcp"), endpoint: z.string().min(1), useTls: z.boolean().optional() }),
  z.object({ id: z.string().min(1), type: z.literal("remoteSsh"), host: z.string().min(1), sshPort: z.number().int().min(1).max(65535).optional(), daemonPort: z.number().int().min(1).max(65535).optional() }),
]);

function localAddress(address: string, ssh = false) {
  const raw = ssh ? address.trim().split("@").pop()! : address.trim();
  // URL normalizes shortened/numeric IPv4 and expanded/mapped IPv6 spellings
  // consistently in the browser and daemon. Bare SSH IPv6 has no port suffix.
  const endpoint = ssh && raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  let hostname: string;
  try { hostname = new URL(endpoint.includes("://") ? endpoint : `http://${endpoint}`).hostname.toLowerCase().replace(/\.$/, ""); }
  catch { return false; } // Preserve SSH aliases or legacy endpoints we cannot normalize.
  if (hostname === "localhost" || hostname === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  const ipv6 = hostname.replace(/^\[|\]$/g, "");
  return ipv6 === "::" || ipv6 === "::1" || ipv6 === "::ffff:0:0" || /^::ffff:7f[\da-f]{2}:[\da-f]{1,4}$/.test(ipv6);
}

function portableConnection(connection: Record<string, unknown>) {
  if (connection.type === "relay") return true;
  if (connection.type === "remoteSsh") return !localAddress(String(connection.host), true);
  if (connection.type === "directTcp") return !localAddress(String(connection.endpoint));
  return false;
}

export function portableState(state: ClientState): ClientState {
  const preferences = Object.fromEntries(preferenceKeys.filter((key) => key in state.preferences).flatMap((key) => {
    const value = state.preferences[key];
    if (key !== "@paseo:preferred-editor") JSON.parse(value);
    if (key === "@paseo:app-settings") {
      const settings = JSON.parse(value);
      if (settings?.usage && typeof settings.usage === "object" && "serverId" in settings.usage) {
        const { serverId: _serverId, ...usage } = settings.usage;
        const portable = { ...settings, usage };
        if (!Object.keys(usage).length) delete portable.usage;
        if (!Object.keys(portable).length) return [];
        return [[key, JSON.stringify(portable)]];
      }
    }
    return [[key, value]];
  }));
  const preferenceCoverage = state.preferenceCoverage?.filter((key) => (preferenceKeys as readonly string[]).includes(key));
  return { preferences, ...(preferenceCoverage ? { preferenceCoverage } : {}), ...(state.hostSettings ? { hostSettings: hostSettingsSchema.parse(state.hostSettings) } : {}), ...(state.localHostIds?.length ? { localHostIds: state.localHostIds } : {}), hosts: state.hosts.flatMap((host) => {
    if (host.serverId.startsWith("local:")) return [];
    const connections = host.connections.filter(portableConnection).map((c) => connectionSchema.parse(c));
    if (!connections.length) return [];
    return [{ ...host, connections, preferredConnectionId: connections.some((c) => c.id === host.preferredConnectionId) ? host.preferredConnectionId : connections[0].id }];
  }) };
}
