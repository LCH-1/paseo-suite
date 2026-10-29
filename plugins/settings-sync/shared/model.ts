import { z } from "zod";
import { providerCredentialsSchema } from "./provider-credentials";
import { asProviders, providerFamily } from "./provider-paths";
import { hostSettingsSchema } from "./host-settings";

export const ID = "settings-sync";
export const MAX_BYTES = 5 * 1024 * 1024;
export const pluginId = z.string().regex(/^[a-z][a-z0-9-]*$/).max(80);
export const settingsId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(120);
export const jsonObject = z.record(z.string(), z.json());
export const clientStateSchema = z.object({
  hosts: z.array(z.object({
    serverId: z.string().min(1), label: z.string().optional(), password: z.string().optional(),
    appearance: jsonObject.optional(), lifecycle: jsonObject.optional(),
    connections: z.array(jsonObject), preferredConnectionId: z.string().nullable().optional(),
    createdAt: z.string().optional(), updatedAt: z.string().optional(),
  })),
  preferences: z.record(z.string(), z.string()),
  preferenceCoverage: z.array(z.string()).max(100).refine((keys) => new Set(keys).size === keys.length, "중복 앱 설정 범위입니다.").optional(),
  hostSettings: hostSettingsSchema.optional(),
  localHostIds: z.array(z.string().min(1)).max(5000).refine((ids) => new Set(ids).size === ids.length).optional(),
}).superRefine((client, context) => {
  if (client.preferenceCoverage && Object.keys(client.preferences).some((key) => !client.preferenceCoverage!.includes(key))) {
    context.addIssue({ code: "custom", message: "앱 설정이 제공된 범위와 일치하지 않습니다." });
  }
});
export const pluginSchema = z.object({
  id: pluginId, enabled: z.boolean(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length <= 1500),
  settings: z.record(z.string(), z.object({ version: z.number().int().positive(), values: z.json() })),
});
export const scopeFlagsSchema = z.object({
  hosts: z.boolean(), preferences: z.boolean(), providers: z.boolean(), config: z.boolean(), plugins: z.boolean(),
});
export const snapshotSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]), createdAt: z.string().datetime(), device: z.string(),
  client: clientStateSchema, config: jsonObject, plugins: z.array(pluginSchema).max(100),
  scopes: scopeFlagsSchema.optional(),
  credentials: providerCredentialsSchema.optional(),
}).superRefine((snapshot, context) => {
  const providers = asProviders(snapshot.config.providers);
  for (const record of snapshot.credentials?.records ?? []) {
    for (const id of record.providerIds) {
      if (!(id in providers) || providerFamily(id, providers) !== record.vendor) context.addIssue({ code: "custom", path: ["credentials"], message: "인증 백업과 프로바이더 설정의 연결이 올바르지 않습니다." });
    }
  }
});
export type ClientState = z.infer<typeof clientStateSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type PluginBackup = z.infer<typeof pluginSchema>;

export const portableConfigKeys = [
  "providers", "metadataGeneration", "autoArchiveAfterMerge", "enableTerminalAgentHooks",
  "appendSystemPrompt", "terminalProfiles", "agentProfiles", "browserTools", "mcp",
] as const;

export const legacyPreferenceKeys = [
  "@paseo:app-settings", "@paseo:keyboard-shortcut-overrides", "@paseo:create-agent-preferences",
  "@paseo:preferred-editor", "@paseo:changes-preferences",
] as const;

export const preferenceKeys = [
  ...legacyPreferenceKeys,
  "sidebar-view", "sidebar-collapsed-sections", "sidebar-project-workspace-order",
] as const;

export function pickConfig(config: Record<string, unknown>) {
  const nested = { metadataGeneration: ["providers"], browserTools: ["enabled"], mcp: ["injectIntoAgents"] } as const;
  return Object.fromEntries(portableConfigKeys.flatMap((key) => {
    if (!(key in config)) return [];
    const value = config[key];
    if (!(key in nested)) return [[key, value]];
    const supported = nested[key as keyof typeof nested];
    const selected = Object.fromEntries(supported.flatMap((field) => value && typeof value === "object" && field in value ? [[field, (value as Record<string, unknown>)[field]]] : []));
    return Object.keys(selected).length ? [[key, selected]] : [];
  }));
}
