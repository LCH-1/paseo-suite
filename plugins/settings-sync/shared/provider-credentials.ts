import { z } from "zod";

const jsonObject = z.record(z.string(), z.json()).refine((value) => JSON.stringify(value).length <= 1_048_576, "프로바이더 인증 데이터가 너무 큽니다.");
const select = (value: Record<string, z.core.util.JSONType>, keys: string[]) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
const OAUTH_ACCOUNT_FIELDS = ["accountUuid", "accountId", "emailAddress", "organizationUuid", "organizationId", "displayName", "fullName", "billingType", "organizationRole", "workspaceRole", "hasExtraUsageEnabled", "accountCreatedAt", "subscriptionCreatedAt", "ccOnboardingFlags", "claudeCodeTrialDurationDays", "claudeCodeTrialEndsAt", "planDisplayName", "profileFetchedAt", "seatTier"];
export function normalizeVendorCredential(vendor: string, value: Record<string, z.core.util.JSONType>): Record<string, z.core.util.JSONType> {
  if (vendor === "claude") {
    const oauth = value.claudeAiOauth;
    return oauth && typeof oauth === "object" && !Array.isArray(oauth) ? { claudeAiOauth: select(oauth, ["accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt", "clientId", "scopes", "subscriptionType", "subscriptionTypeSource", "subscriptionTypeVerifiedAt", "rateLimitTier"]) } : {};
  }
  if (vendor === "codex") {
    const result = select(value, ["OPENAI_API_KEY", "auth_mode", "tokens", "last_refresh"]);
    const tokens = result.tokens;
    if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
      const selected = select(tokens, ["access_token", "refresh_token", "id_token", "account_id", "oauth_provenance", "login_owner_id"]);
      const provenance = selected.oauth_provenance;
      if (provenance && typeof provenance === "object" && !Array.isArray(provenance)) selected.oauth_provenance = select(provenance, ["issuer", "client_id"]);
      result.tokens = selected;
    }
    if (result.auth_mode === "apikey" || result.auth_mode == null && typeof result.OPENAI_API_KEY === "string" && result.OPENAI_API_KEY) delete result.tokens;
    else if (typeof result.OPENAI_API_KEY === "string" && result.OPENAI_API_KEY) result.OPENAI_API_KEY = null;
    return result;
  }
  return value;
}
const metadataSchema = z.object({
  oauthAccount: jsonObject.transform((value) => select(value, OAUTH_ACCOUNT_FIELDS)).optional(),
  hasCompletedOnboarding: z.boolean().optional(),
  lastOnboardingVersion: z.string().max(200).optional(),
  accounts: z.array(z.object({ id: z.string().min(1).max(200), base: z.enum(["claude", "codex"]), name: z.string().max(500).optional(), home: z.null(), email: z.string().max(1000).nullable(), identity: z.string().max(2000).nullable(), signedIn: z.boolean() }).strict()).max(100).optional(),
}).strict();

export const providerCredentialRecordSchema = z.object({
  id: z.string().regex(/^(claude|codex|cursor|opencode|pi)-[a-f0-9]{24}$/),
  vendor: z.enum(["claude", "codex", "cursor", "opencode", "pi"]),
  providerIds: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).max(100),
  credential: jsonObject,
  metadata: metadataSchema,
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative().nullable(),
}).strict().superRefine((record, ctx) => {
  if (!record.id.startsWith(`${record.vendor}-`) || new Set(record.providerIds).size !== record.providerIds.length) ctx.addIssue({ code: "custom", message: "잘못된 프로바이더 인증 연결입니다." });
  const oauth = record.credential.claudeAiOauth;
  const tokens = record.credential.tokens;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (record.vendor === "claude" && (!object(oauth) || typeof oauth.accessToken !== "string" || !oauth.accessToken)) ctx.addIssue({ code: "custom", message: "Claude OAuth 인증 데이터가 없습니다." });
  if (record.vendor === "codex" && !(typeof record.credential.OPENAI_API_KEY === "string" && record.credential.OPENAI_API_KEY || object(tokens) && typeof tokens.access_token === "string" && tokens.access_token)) ctx.addIssue({ code: "custom", message: "Codex 인증 데이터가 없습니다." });
  if (record.vendor === "codex") {
    const mode = record.credential.auth_mode;
    if (mode != null && (typeof mode !== "string" || !["apikey", "chatgpt", "chatgptAuthTokens"].includes(mode)) || ["agent_identity", "personal_access_token", "bedrock_api_key", "bedrock_access_keys"].some((key) => record.credential[key] != null)) ctx.addIssue({ code: "custom", message: "지원하지 않는 Codex 인증 방식입니다." });
    if (object(tokens)) {
      if (tokens.login_owner_id != null && typeof tokens.login_owner_id !== "string") ctx.addIssue({ code: "custom", message: "잘못된 Codex 로그인 소유 정보입니다." });
      if (tokens.oauth_provenance != null && (!object(tokens.oauth_provenance) || typeof tokens.oauth_provenance.issuer !== "string" || typeof tokens.oauth_provenance.client_id !== "string")) ctx.addIssue({ code: "custom", message: "잘못된 Codex OAuth 발급 정보입니다." });
    }
    if (mode === "apikey" && !(typeof record.credential.OPENAI_API_KEY === "string" && record.credential.OPENAI_API_KEY) || (mode === "chatgpt" || mode === "chatgptAuthTokens") && !(object(tokens) && typeof tokens.access_token === "string" && tokens.access_token)) ctx.addIssue({ code: "custom", message: "선택된 Codex 인증 방식의 자격증명이 없습니다." });
  }
}).transform((record) => ({ ...record, credential: normalizeVendorCredential(record.vendor, record.credential) }));

export const providerCredentialsSchema = z.object({ version: z.literal(1), records: z.array(providerCredentialRecordSchema).max(200) }).strict().superRefine((bundle, ctx) => {
  const ids = new Set<string>();
  const providers = new Set<string>();
  const accounts = new Set<string>();
  for (const record of bundle.records) {
    if (ids.has(record.id)) ctx.addIssue({ code: "custom", message: "중복 프로바이더 인증 ID입니다." });
    ids.add(record.id);
    for (const provider of record.providerIds) {
      if (providers.has(provider)) ctx.addIssue({ code: "custom", message: "동일 프로바이더에 여러 인증이 연결되었습니다." });
      providers.add(provider);
    }
    for (const account of record.metadata.accounts ?? []) {
      if (account.base !== record.vendor || accounts.has(account.id)) ctx.addIssue({ code: "custom", message: "잘못되었거나 중복된 계정 목록 연결입니다." });
      accounts.add(account.id);
    }
  }
});

export type ProviderCredentialRecord = z.infer<typeof providerCredentialRecordSchema>;
export type ProviderCredentials = z.infer<typeof providerCredentialsSchema>;

export function canRenewClaudeCredential(local: ProviderCredentialRecord | null | undefined, incoming: ProviderCredentialRecord, now = Date.now()) {
  return !!local && local.vendor === "claude" && incoming.vendor === "claude" && local.identity === incoming.identity && local.expiresAt !== null && local.expiresAt <= now && incoming.expiresAt !== null && incoming.expiresAt > now;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function credentialIdentityDigest(bundle: ProviderCredentials | undefined): string {
  return stable((bundle?.records ?? []).map(({ id, vendor, providerIds, identity, metadata }) => ({ id, vendor, providerIds: [...providerIds].sort(), identity, ...(metadata.accounts?.length ? { accounts: [...metadata.accounts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) } : {}) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function credentialFreshnessDigest(bundle: ProviderCredentials | undefined): string {
  return stable((bundle?.records ?? []).map((record) => {
    const { oauthAccount, ...metadata } = record.metadata;
    const { profileFetchedAt: _profileFetchedAt, ...account } = oauthAccount ?? {};
    return { ...record, providerIds: [...record.providerIds].sort(), metadata: { ...metadata, ...(Object.keys(account).length ? { oauthAccount: account } : {}) } };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function newerCredential(a: ProviderCredentialRecord, b: ProviderCredentialRecord): ProviderCredentialRecord {
  if (a.identity !== b.identity) return b;
  const expiry = (a.expiresAt ?? 0) - (b.expiresAt ?? 0);
  const chosen = expiry ? expiry > 0 ? a : b : a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt ? a : b : stable(a) >= stable(b) ? a : b;
  const selected = { ...chosen, id: b.id, providerIds: b.providerIds, metadata: b.metadata };
  if (a.vendor !== "pi" && a.vendor !== "opencode" || a.vendor !== b.vendor) return selected;
  const credential = { ...chosen.credential };
  for (const key of Object.keys(credential)) {
    const left = a.credential[key]; const right = b.credential[key];
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right) || left.type !== "oauth" || right.type !== "oauth" || typeof left.expires !== "number" || typeof right.expires !== "number") continue;
    credential[key] = left.expires > right.expires ? left : right.expires > left.expires ? right : stable(left) >= stable(right) ? left : right;
  }
  const expiries = Object.values(credential).flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.expires === "number" ? [item.expires] : []);
  return { ...selected, credential, updatedAt: Math.max(a.updatedAt, b.updatedAt), expiresAt: expiries.length ? Math.min(...expiries) : null };
}

export function mergeCredentialFreshness(local: ProviderCredentials | undefined, incoming: ProviderCredentials): ProviderCredentials {
  const records = new Map((local?.records ?? []).map((record) => [record.id, record]));
  return { version: 1, records: incoming.records.map((record) => {
    const previous = records.get(record.id);
    return previous && previous.identity === record.identity ? newerCredential(previous, record) : record;
  }) };
}
