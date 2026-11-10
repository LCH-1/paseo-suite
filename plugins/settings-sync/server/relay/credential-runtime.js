// Generated from Paseo Nest Settings Sync 0.3.10 (526a374). Claude-only callers retain its CLI locks, journal and conditional writes.

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/provider-credentials.ts
import { spawn as spawn3 } from "node:child_process";
import { createHash as createHash4 } from "node:crypto";
import { lstat as lstat4, mkdir as mkdir4, readFile as readFile3, realpath as realpath3, rename as rename3, rm as rm3, symlink, utimes as utimes3, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import path6 from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/shared/provider-credentials.ts
import { z } from "zod";
var jsonObject = z.record(z.string(), z.json()).refine((value) => JSON.stringify(value).length <= 1048576, "\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uB370\uC774\uD130\uAC00 \uB108\uBB34 \uD07D\uB2C8\uB2E4.");
var select = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== void 0).map((key) => [key, value[key]]));
var OAUTH_ACCOUNT_FIELDS = ["accountUuid", "accountId", "emailAddress", "organizationUuid", "organizationId", "displayName", "fullName", "billingType", "organizationRole", "workspaceRole", "hasExtraUsageEnabled", "accountCreatedAt", "subscriptionCreatedAt", "ccOnboardingFlags", "claudeCodeTrialDurationDays", "claudeCodeTrialEndsAt", "planDisplayName", "profileFetchedAt", "seatTier"];
function normalizeVendorCredential(vendor, value) {
  if (vendor === "claude") {
    const oauth2 = value.claudeAiOauth;
    return oauth2 && typeof oauth2 === "object" && !Array.isArray(oauth2) ? { claudeAiOauth: select(oauth2, ["accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt", "clientId", "scopes", "subscriptionType", "subscriptionTypeSource", "subscriptionTypeVerifiedAt", "rateLimitTier"]) } : {};
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
var metadataSchema = z.object({
  oauthAccount: jsonObject.transform((value) => select(value, OAUTH_ACCOUNT_FIELDS)).optional(),
  hasCompletedOnboarding: z.boolean().optional(),
  lastOnboardingVersion: z.string().max(200).optional(),
  accounts: z.array(z.object({ id: z.string().min(1).max(200), base: z.enum(["claude", "codex"]), name: z.string().max(500).optional(), home: z.null(), email: z.string().max(1e3).nullable(), identity: z.string().max(2e3).nullable(), signedIn: z.boolean() }).strict()).max(100).optional()
}).strict();
var providerCredentialRecordSchema = z.object({
  id: z.string().regex(/^(claude|codex|cursor|opencode|pi)-[a-f0-9]{24}$/),
  vendor: z.enum(["claude", "codex", "cursor", "opencode", "pi"]),
  providerIds: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1).max(100),
  credential: jsonObject,
  metadata: metadataSchema,
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative().nullable()
}).strict().superRefine((record2, ctx) => {
  if (!record2.id.startsWith(`${record2.vendor}-`) || new Set(record2.providerIds).size !== record2.providerIds.length) ctx.addIssue({ code: "custom", message: "\uC798\uBABB\uB41C \uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uC5F0\uACB0\uC785\uB2C8\uB2E4." });
  const oauth2 = record2.credential.claudeAiOauth;
  const tokens = record2.credential.tokens;
  const object4 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  if (record2.vendor === "claude" && (!object4(oauth2) || typeof oauth2.accessToken !== "string" || !oauth2.accessToken)) ctx.addIssue({ code: "custom", message: "Claude OAuth \uC778\uC99D \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
  if (record2.vendor === "codex" && !(typeof record2.credential.OPENAI_API_KEY === "string" && record2.credential.OPENAI_API_KEY || object4(tokens) && typeof tokens.access_token === "string" && tokens.access_token)) ctx.addIssue({ code: "custom", message: "Codex \uC778\uC99D \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
  if (record2.vendor === "codex") {
    const mode = record2.credential.auth_mode;
    if (mode != null && (typeof mode !== "string" || !["apikey", "chatgpt", "chatgptAuthTokens"].includes(mode)) || ["agent_identity", "personal_access_token", "bedrock_api_key", "bedrock_access_keys"].some((key) => record2.credential[key] != null)) ctx.addIssue({ code: "custom", message: "\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 Codex \uC778\uC99D \uBC29\uC2DD\uC785\uB2C8\uB2E4." });
    if (object4(tokens)) {
      if (tokens.login_owner_id != null && typeof tokens.login_owner_id !== "string") ctx.addIssue({ code: "custom", message: "\uC798\uBABB\uB41C Codex \uB85C\uADF8\uC778 \uC18C\uC720 \uC815\uBCF4\uC785\uB2C8\uB2E4." });
      if (tokens.oauth_provenance != null && (!object4(tokens.oauth_provenance) || typeof tokens.oauth_provenance.issuer !== "string" || typeof tokens.oauth_provenance.client_id !== "string")) ctx.addIssue({ code: "custom", message: "\uC798\uBABB\uB41C Codex OAuth \uBC1C\uAE09 \uC815\uBCF4\uC785\uB2C8\uB2E4." });
    }
    if (mode === "apikey" && !(typeof record2.credential.OPENAI_API_KEY === "string" && record2.credential.OPENAI_API_KEY) || (mode === "chatgpt" || mode === "chatgptAuthTokens") && !(object4(tokens) && typeof tokens.access_token === "string" && tokens.access_token)) ctx.addIssue({ code: "custom", message: "\uC120\uD0DD\uB41C Codex \uC778\uC99D \uBC29\uC2DD\uC758 \uC790\uACA9\uC99D\uBA85\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
  }
}).transform((record2) => ({ ...record2, credential: normalizeVendorCredential(record2.vendor, record2.credential) }));
var providerCredentialsSchema = z.object({ version: z.literal(1), records: z.array(providerCredentialRecordSchema).max(200) }).strict().superRefine((bundle, ctx) => {
  const ids = /* @__PURE__ */ new Set();
  const providers = /* @__PURE__ */ new Set();
  const accounts = /* @__PURE__ */ new Set();
  for (const record2 of bundle.records) {
    if (ids.has(record2.id)) ctx.addIssue({ code: "custom", message: "\uC911\uBCF5 \uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D ID\uC785\uB2C8\uB2E4." });
    ids.add(record2.id);
    for (const provider of record2.providerIds) {
      if (providers.has(provider)) ctx.addIssue({ code: "custom", message: "\uB3D9\uC77C \uD504\uB85C\uBC14\uC774\uB354\uC5D0 \uC5EC\uB7EC \uC778\uC99D\uC774 \uC5F0\uACB0\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
      providers.add(provider);
    }
    for (const account of record2.metadata.accounts ?? []) {
      if (account.base !== record2.vendor || accounts.has(account.id)) ctx.addIssue({ code: "custom", message: "\uC798\uBABB\uB418\uC5C8\uAC70\uB098 \uC911\uBCF5\uB41C \uACC4\uC815 \uBAA9\uB85D \uC5F0\uACB0\uC785\uB2C8\uB2E4." });
      accounts.add(account.id);
    }
  }
});
function canRenewClaudeCredential(local, incoming, now = Date.now()) {
  return !!local && local.vendor === "claude" && incoming.vendor === "claude" && local.identity === incoming.identity && local.expiresAt !== null && local.expiresAt <= now && incoming.expiresAt !== null && incoming.expiresAt > now;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function newerCredential(a, b) {
  if (a.identity !== b.identity) return b;
  const expiry = (a.expiresAt ?? 0) - (b.expiresAt ?? 0);
  const chosen = expiry ? expiry > 0 ? a : b : a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt ? a : b : stable(a) >= stable(b) ? a : b;
  const selected = { ...chosen, id: b.id, providerIds: b.providerIds, metadata: b.metadata };
  if (a.vendor !== "pi" && a.vendor !== "opencode" || a.vendor !== b.vendor) return selected;
  const credential = { ...chosen.credential };
  for (const key of Object.keys(credential)) {
    const left = a.credential[key];
    const right = b.credential[key];
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right) || left.type !== "oauth" || right.type !== "oauth" || typeof left.expires !== "number" || typeof right.expires !== "number") continue;
    credential[key] = left.expires > right.expires ? left : right.expires > left.expires ? right : stable(left) >= stable(right) ? left : right;
  }
  const expiries = Object.values(credential).flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.expires === "number" ? [item.expires] : []);
  return { ...selected, credential, updatedAt: Math.max(a.updatedAt, b.updatedAt), expiresAt: expiries.length ? Math.min(...expiries) : null };
}

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/vendor-credential-files.ts
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z as z2 } from "zod";

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/shared/provider-paths.ts
var vendorCommands = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  cursor: "cursor-agent",
  kimi: "kimi",
  kiro: "kiro-cli",
  trae: "trae-cli"
};
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asProviders(value) {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, entry]) => object(entry) ? [[id, entry]] : []));
}
function providerFamily(id, providers) {
  const visited = /* @__PURE__ */ new Set();
  let current = id;
  while (!visited.has(current)) {
    visited.add(current);
    if (providers[current]?.extends === "acp") {
      const command = providers[current]?.command;
      return Array.isArray(command) && typeof command[0] === "string" && /^cursor-agent(?:\.(?:exe|cmd|bat|ps1))?$/i.test(command[0].replaceAll("\\", "/").split("/").at(-1)) ? "cursor" : null;
    }
    if (current in vendorCommands) return current;
    const parent = providers[current]?.extends;
    if (typeof parent !== "string") return null;
    current = parent;
  }
  return null;
}

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/vendor-credential-files.ts
var LIMIT = 1048576;
var object2 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
var token = z2.string().max(262144);
var nonempty = token.min(1);
var stringMap = z2.record(z2.string().max(200), token);
var oauth = { type: z2.literal("oauth"), access: nonempty, refresh: token, expires: z2.number().finite().nonnegative() };
var cursorSchema = z2.object({
  accessToken: token.optional(),
  refreshToken: token.optional(),
  apiKey: token.optional(),
  bedrockCredentials: z2.object({ accessKey: nonempty, secretKey: nonempty, sessionToken: token.optional() }).strict().optional()
}).strict().refine((value) => !!(value.accessToken || value.apiKey || value.bedrockCredentials));
var piSchema = z2.record(z2.string().min(1).max(300), z2.union([
  z2.object({ type: z2.literal("api_key"), key: token.optional(), env: stringMap.optional() }).strict().refine((value) => !!value.key || !!Object.keys(value.env ?? {}).length).refine((value) => !value.key?.startsWith("!")),
  z2.object({ ...oauth, accountId: token.optional(), enterpriseUrl: token.optional(), clientId: token.optional(), scope: token.optional(), availableModelIds: z2.array(z2.string().max(300)).max(2e3).optional() }).strict()
]));
var opencodeSchema = z2.record(z2.string().min(1).max(2e3), z2.union([
  z2.object({ ...oauth, accountId: token.optional(), enterpriseUrl: token.optional() }).strict(),
  z2.object({ type: z2.literal("api"), key: nonempty, metadata: stringMap.optional() }).strict(),
  z2.object({ type: z2.literal("wellknown"), key: nonempty, token: nonempty }).strict()
]));
function context(options) {
  return { home: path.resolve(options.home), userHome: options.userHome ?? homedir(), platform: options.platform ?? process.platform, env: options.env ?? process.env };
}
function expand(value, fallback, userHome) {
  const raw = value || fallback;
  if (raw.startsWith("@paseo-") || /[\u0000\r\n]/.test(raw)) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uD504\uB85C\uD544 \uACBD\uB85C\uB97C \uD604\uC7AC \uAE30\uAE30\uC758 \uACBD\uB85C\uB85C \uBA3C\uC800 \uBCC0\uD658\uD558\uC138\uC694.");
  return path.resolve(raw === "~" ? userHome : /^~[\\/]/.test(raw) ? path.join(userHome, raw.slice(2)) : raw);
}
function vendorCredentialFilePath(vendor, options, env = options.env ?? process.env) {
  const home = options.userHome ?? homedir();
  const platform = options.platform ?? process.platform;
  if (vendor === "cursor") {
    if (platform === "win32") return path.join(expand(env.APPDATA, path.join(home, "AppData", "Roaming"), home), "Cursor", "auth.json");
    if (platform === "darwin") return path.join(home, ".cursor", "auth.json");
    return path.join(expand(env.XDG_CONFIG_HOME, path.join(home, ".config"), home), "cursor", "auth.json");
  }
  if (vendor === "pi") return path.join(expand(env.PI_CODING_AGENT_DIR, path.join(home, ".pi", "agent"), home), "auth.json");
  return path.join(expand(env.XDG_DATA_HOME, path.join(home, ".local", "share"), home), "opencode", "auth.json");
}
function effectiveEnvironment(id, providers, base, visited = /* @__PURE__ */ new Set()) {
  if (visited.has(id)) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC0C1\uC18D \uC124\uC815\uC5D0 \uC21C\uD658\uC774 \uC788\uC2B5\uB2C8\uB2E4.");
  visited.add(id);
  const entry = providers[id];
  const inherited = typeof entry?.extends === "string" && providers[entry.extends] ? effectiveEnvironment(entry.extends, providers, base, visited) : base;
  const own = object2(entry?.env) ? Object.fromEntries(Object.entries(entry.env).filter((pair) => typeof pair[1] === "string")) : {};
  return { ...inherited, ...own };
}
function family(id, providers) {
  const detected = providerFamily(id, providers);
  if (detected === "cursor" || detected === "pi" || detected === "opencode") return detected;
  const command = providers[id]?.command;
  if (providers[id]?.extends === "acp" && Array.isArray(command) && typeof command[0] === "string" && /^cursor-agent(?:\.(?:cmd|exe|bat|ps1))?$/i.test(command[0].replaceAll("\\", "/").split("/").at(-1))) return "cursor";
  return null;
}
function profiles(options, value, enabledOnly = true) {
  const providers = asProviders(value);
  const result = /* @__PURE__ */ new Map();
  for (const id of Object.keys(providers).sort()) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || enabledOnly && providers[id].enabled === false) continue;
    const vendor = family(id, providers);
    if (!vendor) continue;
    const env = effectiveEnvironment(id, providers, options.env);
    const file = vendorCredentialFilePath(vendor, options, env);
    const key = `${vendor}:${file}:${env.AGENT_CLI_CREDENTIAL_STORE ?? "default"}:${hash([env.CURSOR_API_KEY, env.CURSOR_AUTH_TOKEN, env.OPENCODE_AUTH_CONTENT])}`;
    const previous = result.get(key);
    if (previous) previous.providerIds.push(id);
    else result.set(key, { vendor, providerIds: [id], file, env });
  }
  return [...result.values()];
}
async function safeParents(file) {
  let current = path.dirname(path.resolve(file));
  while (true) {
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uACBD\uB85C\uC5D0 \uC2EC\uBCFC\uB9AD \uB9C1\uD06C\uB098 \uC798\uBABB\uB41C \uB514\uB809\uD130\uB9AC\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function readKnown(file) {
  try {
    await safeParents(file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error();
    const raw = await readFile(file, "utf8");
    if (Buffer.byteLength(raw) > LIMIT) throw new Error();
    return { raw, updatedAt: Math.max(0, Math.trunc(stat.mtimeMs)) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uD30C\uC77C\uC744 \uC548\uC804\uD558\uAC8C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uAD8C\uD55C\uACFC \uC2EC\uBCFC\uB9AD \uB9C1\uD06C\uB97C \uD655\uC778\uD558\uC138\uC694.");
  }
}
function parse(vendor, value) {
  const parsed = (vendor === "cursor" ? cursorSchema : vendor === "pi" ? piSchema : opencodeSchema).safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > LIMIT) throw new Error(`${vendor} \uC778\uC99D \uD30C\uC77C \uD615\uC2DD\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uAC70\uB098 \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC5D0 API \uD0A4\uB97C \uC9C0\uC815\uD558\uC138\uC694.`);
  return parsed.data;
}
function parseFile(vendor, raw) {
  let value;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${vendor} \uC778\uC99D \uD30C\uC77C\uC774 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.`);
  }
  if (!object2(value)) return parse(vendor, value);
  if (!Object.keys(value).length) return null;
  if (vendor === "cursor") {
    const known = Object.fromEntries(["accessToken", "refreshToken", "apiKey", "bedrockCredentials"].filter((name) => value[name] !== void 0 && value[name] !== null).map((name) => [name, value[name]]));
    if (!Object.keys(known).length) throw new Error("cursor \uC778\uC99D \uD30C\uC77C \uD615\uC2DD\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. Cursor CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.");
    return parse(vendor, known);
  }
  return parse(vendor, value);
}
function jwt(value) {
  if (typeof value !== "string") return {};
  try {
    const claims = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8"));
    return object2(claims) ? claims : {};
  } catch {
    return {};
  }
}
function identity(vendor, credential) {
  if (vendor === "cursor") return hash([vendor, jwt(credential.accessToken).sub || credential.apiKey || credential.refreshToken || credential.accessToken || (object2(credential.bedrockCredentials) ? credential.bedrockCredentials.accessKey : null)]);
  return hash([vendor, Object.entries(credential).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => {
    const entry = object2(value) ? value : {};
    return [id, entry.type, entry.accountId || jwt(entry.access).sub || entry.refresh || (entry.type === "wellknown" ? entry.token : entry.key) || entry.access || entry.env];
  })]);
}
function expiresAt(vendor, credential) {
  const expirations = vendor === "cursor" ? [Number(jwt(credential.accessToken).exp) * 1e3] : Object.values(credential).map((entry) => object2(entry) ? entry.expires : null);
  const finite = expirations.filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return finite.length ? Math.min(...finite) : null;
}
function record(profile, source, credential) {
  const ids = [...profile.providerIds].sort();
  const primary = ids.includes(profile.vendor) ? profile.vendor : ids[0];
  return { id: `${profile.vendor}-${hash(primary).slice(0, 24)}`, vendor: profile.vendor, providerIds: ids, credential, metadata: {}, identity: identity(profile.vendor, credential), updatedAt: source.updatedAt, expiresAt: expiresAt(profile.vendor, credential) };
}
function fileEnvironment(profile, options) {
  return profile.vendor === "cursor" ? { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "", APPDATA: path.dirname(path.dirname(profile.file)), XDG_CONFIG_HOME: path.dirname(path.dirname(profile.file)) } : profile.vendor === "pi" ? { PI_CODING_AGENT_DIR: path.dirname(profile.file) } : { XDG_DATA_HOME: path.dirname(path.dirname(profile.file)), OPENCODE_AUTH_CONTENT: "" };
}
function applyFileEnvironment(providers, profile, options) {
  for (const id of profile.providerIds) {
    const entry = object2(providers[id]) ? providers[id] : {};
    const env = object2(entry.env) ? { ...entry.env } : {};
    const keys = profile.vendor === "cursor" ? ["APPDATA", "XDG_CONFIG_HOME", "AGENT_CLI_CREDENTIAL_STORE", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] : profile.vendor === "pi" ? ["PI_CODING_AGENT_DIR"] : ["XDG_DATA_HOME", "OPENCODE_AUTH_CONTENT"];
    for (const key of keys) delete env[key];
    providers[id] = { ...entry, env: { ...env, ...fileEnvironment(profile, options) } };
  }
}
async function unsupported(profile, options) {
  if (profile.vendor === "cursor") {
    if (profile.env.AGENT_CLI_CREDENTIAL_STORE === "memory") return { store: "memory", reason: "Cursor\uC758 \uBA54\uBAA8\uB9AC \uC778\uC99D\uC740 \uB0B4\uBCF4\uB0BC \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC5D0 API \uD0A4\uB97C \uC9C0\uC815\uD558\uC138\uC694." };
    if (options.platform === "darwin" && profile.env.AGENT_CLI_CREDENTIAL_STORE !== "file") return { store: "keychain", reason: "Cursor macOS \uD0A4\uCCB4\uC778 \uB0B4\uBCF4\uB0B4\uAE30\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC5D0 API \uD0A4\uB97C \uC9C0\uC815\uD558\uC138\uC694." };
  }
  if (profile.vendor === "opencode") {
    try {
      await lstat(profile.env.OPENCODE_DB ? expand(profile.env.OPENCODE_DB, "", options.userHome) : path.join(path.dirname(profile.file), "opencode.db"));
      return { store: "database", reason: "OpenCode 2\uC758 \uB370\uC774\uD130\uBCA0\uC774\uC2A4 \uC778\uC99D\uC740 \uD30C\uC77C \uBCF5\uC0AC\uB85C \uB3D9\uAE30\uD654\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. OpenCode\uC5D0\uC11C \uACC4\uC815\uC744 \uC5F0\uACB0\uD558\uAC70\uB098 \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC5D0 API \uD0A4\uB97C \uC9C0\uC815\uD558\uC138\uC694." };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("OpenCode \uC778\uC99D \uC800\uC7A5\uC18C\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
  }
  return null;
}
async function captureVendorCredentials(options, providers) {
  const ctx = context(options);
  const next = structuredClone(providers);
  const records = [];
  const status = [];
  for (const profile of profiles(ctx, providers)) {
    const tokenNames = profile.vendor === "cursor" ? ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] : profile.vendor === "opencode" ? ["OPENCODE_AUTH_CONTENT"] : [];
    if (tokenNames.some((name) => profile.env[name])) {
      if (profile.vendor === "opencode") {
        parseFile("opencode", profile.env.OPENCODE_AUTH_CONTENT);
      }
      for (const id of profile.providerIds) {
        const entry = object2(next[id]) ? next[id] : {};
        next[id] = { ...entry, env: { ...object2(entry.env) ? entry.env : {}, ...Object.fromEntries(tokenNames.filter((name) => profile.env[name]).map((name) => [name, profile.env[name]])) } };
      }
      status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: "environment", store: "environment" });
      continue;
    }
    const blocked = await unsupported(profile, ctx);
    if (blocked) {
      status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: "unsupported", ...blocked });
      continue;
    }
    const source = await readKnown(profile.file);
    const credential = source ? parseFile(profile.vendor, source.raw) : null;
    if (source && credential) {
      records.push(record(profile, source, credential));
      applyFileEnvironment(next, profile, ctx);
    }
    status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: credential ? "available" : "missing", store: credential ? "file" : "none" });
  }
  return { providers: next, records: providerCredentialsSchema.parse({ version: 1, records }).records, status };
}
function managedProfile(options, incoming) {
  if (!/^(cursor|pi|opencode)-[a-f0-9]{24}$/.test(incoming.id)) throw new Error("\uC798\uBABB\uB41C \uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uD504\uB85C\uD544 ID\uC785\uB2C8\uB2E4.");
  const root = path.join(options.home, "settings-sync", "provider-profiles", incoming.id);
  const env = incoming.vendor === "cursor" ? { AGENT_CLI_CREDENTIAL_STORE: "file", ...options.platform === "win32" ? { APPDATA: path.join(root, "roaming") } : { XDG_CONFIG_HOME: path.join(root, "config") } } : incoming.vendor === "pi" ? { PI_CODING_AGENT_DIR: root } : { XDG_DATA_HOME: path.join(root, "data") };
  return { vendor: incoming.vendor, providerIds: incoming.providerIds, env, file: vendorCredentialFilePath(incoming.vendor, options, env) };
}
async function prepareVendorCredentialRestore(options, providers, input, currentProviders = providers) {
  const parsed = providerCredentialsSchema.safeParse({ version: 1, records: input });
  if (!parsed.success) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uBC31\uC5C5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const ctx = context(options);
  const next = structuredClone(providers);
  const incomingProviders = asProviders(providers);
  const localProfiles = profiles(ctx, currentProviders, false);
  const undo = [];
  let finished = false;
  const rollback = async () => {
    if (finished) return;
    let failed = false;
    for (const action of [...undo].reverse()) {
      try {
        await action();
      } catch {
        failed = true;
      }
    }
    finished = true;
    undo.length = 0;
    if (failed) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uBCF5\uAD6C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 CLI\uC758 \uB85C\uADF8\uC778 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.");
  };
  try {
    for (const incoming of parsed.data.records) {
      if (!["cursor", "pi", "opencode"].includes(incoming.vendor)) throw new Error("\uD30C\uC77C \uC778\uC99D \uC5B4\uB311\uD130\uAC00 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD504\uB85C\uBC14\uC774\uB354\uC785\uB2C8\uB2E4.");
      const vendor = incoming.vendor;
      const credential = parse(vendor, incoming.credential);
      if (incoming.providerIds.some((id) => family(id, incomingProviders) !== vendor)) throw new Error("\uC778\uC99D \uBC31\uC5C5\uACFC \uD504\uB85C\uBC14\uC774\uB354 \uC885\uB958\uAC00 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      if (incoming.identity !== identity(vendor, credential)) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uACC4\uC815 \uC2DD\uBCC4\uC790\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      if (incoming.updatedAt > 864e13) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uAC31\uC2E0 \uC2DC\uC810\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      let profile = localProfiles.find((candidate) => candidate.vendor === vendor && candidate.providerIds.some((id) => incoming.providerIds.includes(id)));
      let local = null;
      if (profile && !await unsupported(profile, ctx)) {
        const source = await readKnown(profile.file);
        const localCredential = source ? parseFile(vendor, source.raw) : null;
        if (source && localCredential) local = record(profile, source, localCredential);
      }
      if (!profile || !local || local.identity !== incoming.identity) {
        if (vendor === "cursor" && ctx.platform === "darwin") throw new Error("Cursor macOS \uD30C\uC77C \uC778\uC99D\uC740 \uAE30\uC874\uC758 \uAC19\uC740 \uACC4\uC815\uB9CC \uAC31\uC2E0\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uC774 \uAE30\uAE30\uC758 Cursor\uC5D0\uC11C \uBA3C\uC800 \uB85C\uADF8\uC778\uD558\uC138\uC694.");
        profile = managedProfile(ctx, incoming);
        const source = await readKnown(profile.file);
        const localCredential = source ? parseFile(vendor, source.raw) : null;
        local = source && localCredential ? record(profile, source, localCredential) : null;
      }
      const previous = await readKnown(profile.file);
      const latestCredential = previous ? parseFile(vendor, previous.raw) : null;
      const latest = previous && latestCredential ? record(profile, previous, latestCredential) : null;
      if ((latest?.identity ?? null) !== (local?.identity ?? null)) throw new Error("\uBCF5\uC6D0 \uC911 \uD504\uB85C\uBC14\uC774\uB354 \uACC4\uC815\uC774 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB3D9\uAE30\uD654\uB97C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.");
      const chosen = latest?.identity === incoming.identity ? newerCredential(latest, incoming) : incoming;
      const selected = parse(vendor, chosen.credential);
      const previousObject = vendor === "cursor" && previous ? JSON.parse(previous.raw) : {};
      for (const key of ["accessToken", "refreshToken", "apiKey", "bedrockCredentials"]) delete previousObject[key];
      const raw = JSON.stringify({ ...previousObject, ...selected });
      if (previous?.raw !== raw) {
        await safeParents(profile.file);
        await mkdir(path.dirname(profile.file), { recursive: true, mode: 448 });
        await safeParents(profile.file);
        const temporary = `${profile.file}.${randomUUID()}.tmp`;
        const undoWrite = async () => {
          const current = await readKnown(profile.file);
          if (current?.raw !== raw) throw new Error("\uC778\uC99D \uBCF5\uC6D0 \uC911 \uC778\uC99D \uC815\uBCF4\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          if (previous) {
            await writeFile(profile.file, previous.raw, { mode: 384 });
            await utimes(profile.file, previous.updatedAt / 1e3, previous.updatedAt / 1e3);
          } else await rm(profile.file, { force: true });
        };
        try {
          await writeFile(temporary, raw, { mode: 384, flag: "wx" });
          if (((await readKnown(profile.file))?.raw ?? null) !== (previous?.raw ?? null)) throw new Error("\uBCF5\uC6D0 \uC900\uBE44 \uC911 \uD504\uB85C\uBC14\uC774\uB354 \uACC4\uC815 \uB610\uB294 \uC778\uC99D\uC774 \uAC31\uC2E0\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uCD5C\uC2E0 \uC778\uC99D\uC744 \uBCF4\uC874\uD588\uC73C\uB2C8 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD558\uC138\uC694.");
          await rename(temporary, profile.file);
          undo.push(undoWrite);
          await utimes(profile.file, chosen.updatedAt / 1e3, chosen.updatedAt / 1e3);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      applyFileEnvironment(next, { ...profile, providerIds: incoming.providerIds }, ctx);
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  return { providers: next, rollback, commit: async () => {
    finished = true;
    undo.length = 0;
  } };
}

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/claude-auth-lock.ts
import { lstat as lstat2, mkdir as mkdir2, readFile as readFileLock, realpath, rm as rmLock, rmdir, utimes as utimes2 } from "node:fs/promises";
import path2 from "node:path";
var busy = () => new Error("Claude \uC778\uC99D \uAC31\uC2E0 \uB610\uB294 \uC800\uC7A5 \uC7A0\uAE08\uC774 \uC0AC\uC6A9 \uC911\uC785\uB2C8\uB2E4. \uD604\uC7AC \uC778\uC99D\uC744 \uBCF4\uC874\uD588\uC73C\uB2C8 \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD558\uC138\uC694.");
// A CLI that died mid-refresh leaves its lock behind and would block this profile forever.
// Only a lock with a recorded owner that is gone and has stopped being touched is reclaimed.
async function reapDeadCliLock(file, legacy) {
  let owner;
  try { owner = JSON.parse(await readFileLock(file + ".owner", "utf8")); } catch { return false; }
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { if (error.code !== "ESRCH") return false; }
  const age = async (target) => Date.now() - (await lstat2(target)).mtimeMs;
  if (await age(file).catch(() => 0) < 60000) return false;
  await rmdir(file).catch(() => {});
  await rmLock(file + ".owner", { force: true }).catch(() => {});
  if (await age(legacy).catch(() => 0) >= 60000) await rmdir(legacy).catch(() => {});
  return true;
}

async function lockClaudeAuthentication(directory) {
  const resolved = await realpath(directory);
  const held = [];
  let stopped = false;
  let compromised = false;
  let updating = Promise.resolve();
  let timer;
  const check = () => {
    if (compromised) throw busy();
  };
  const matches = async (entry) => {
    const stat = await lstat2(entry.file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return stat?.isDirectory() && !stat.isSymbolicLink() && stat.birthtimeMs === entry.birthtime && stat.ino === entry.ino;
  };
  const verify = async () => {
    check();
    for (const entry of held) {
      if (!await matches(entry)) {
        compromised = true;
        throw busy();
      }
    }
    check();
  };
  const release = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await updating;
    const failures = [];
    for (const entry of [...held].reverse()) {
      try {
        if (!await matches(entry)) {
          compromised = true;
          continue;
        }
        await rmdir(entry.file);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new Error("Claude \uC778\uC99D \uC800\uC7A5 \uC7A0\uAE08 \uD574\uC81C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  };
  try {
    await reapDeadCliLock(path2.join(resolved, ".oauth_refresh.lock"), `${resolved}.lock`);
    for (const file of [path2.join(resolved, ".oauth_refresh.lock"), `${resolved}.lock`, path2.join(resolved, ".storage-write.lock")]) {
      try {
        await mkdir2(file, { mode: 448 });
      } catch (error) {
        if (error.code === "EEXIST") throw busy();
        throw error;
      }
      const stat = await lstat2(file);
      held.push({ file, birthtime: stat.birthtimeMs, ino: stat.ino });
    }
    timer = setInterval(() => {
      updating = updating.then(async () => {
        if (stopped) return;
        for (const entry of held) {
          if (!await matches(entry)) {
            compromised = true;
            return;
          }
          const now = /* @__PURE__ */ new Date();
          await utimes2(entry.file, now, now);
        }
      }).catch(() => {
        compromised = true;
      });
    }, 5e3);
    timer.unref();
    return { check, verify, release, snapshot: () => held.map((entry) => ({ ...entry })) };
  } catch (error) {
    await release();
    throw error;
  }
}

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/claude-secure-format.ts
var NAME = "claude-code-user";
var CHUNK = 2400;
var MAX_CHUNKS = 256;

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/claude-secure-journal.ts
import { createHash as createHash3, randomBytes as randomBytes2, randomUUID as randomUUID3 } from "node:crypto";
import { lstat as lstat3, mkdir as mkdir3, open as open2, readFile as readFile2, realpath as realpath2, rename as rename2, rm as rm2, rmdir as rmdir2 } from "node:fs/promises";
import path5 from "node:path";
import { z as z7 } from "zod";

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/credential-store.ts
import { spawn } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import path3 from "node:path";
import { z as z3 } from "zod";
var secretReferenceSchema = z3.object({ kind: z3.enum(["dpapi", "secret-service", "keychain"]), value: z3.string() });
function secretCommand(executable, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: "pipe" });
    let output = "";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(new Error(error));
      } else resolve(output.trim());
    };
    const timer = setTimeout(() => finish("OS \uBCF4\uC548 \uC800\uC7A5\uC18C \uC751\uB2F5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD0A4\uB9C1 \uC7A0\uAE08\uC744 \uD655\uC778\uD558\uC138\uC694."), 2e4);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 65536) finish("OS \uBCF4\uC548 \uC800\uC7A5\uC18C \uC751\uB2F5\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4.");
    });
    child.stderr.resume();
    child.on("error", () => finish("OS \uBCF4\uC548 \uC800\uC7A5\uC18C\uB97C \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. Linux\uC5D0\uC11C\uB294 libsecret-tools\uC640 \uB85C\uADF8\uC778 \uD0A4\uB9C1\uC774 \uD544\uC694\uD569\uB2C8\uB2E4."));
    child.on("close", (code) => finish(code === 0 ? void 0 : "OS \uBCF4\uC548 \uC800\uC7A5\uC18C\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uC0AC\uC6A9\uC790\uC640 \uD0A4\uB9C1 \uC7A0\uAE08\uC744 \uD655\uC778\uD558\uC138\uC694."));
    child.stdin.on("error", () => finish("OS \uBCF4\uC548 \uC800\uC7A5\uC18C\uC5D0 \uD0A4\uB97C \uC804\uB2EC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."));
    child.stdin.end(input);
  });
}
var CredentialStore = class {
  constructor(platform = process.platform, run = secretCommand) {
    this.platform = platform;
    this.run = run;
  }
  platform;
  run;
  dpapi(mode, input) {
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${mode}($data,[Text.Encoding]::UTF8.GetBytes('paseo-nest:settings-sync:v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result));`;
    const executable = path3.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return this.run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], input);
  }
  async protect(password) {
    const encoded = Buffer.from(password, "utf8").toString("base64");
    if (this.platform === "win32") return { kind: "dpapi", value: await this.dpapi("Protect", encoded) };
    const id = randomUUID2();
    if (this.platform === "linux") {
      await this.run("secret-tool", ["store", "--label=Paseo Settings Sync", "application", "paseo-nest", "instance", id], encoded);
      return { kind: "secret-service", value: id };
    }
    if (this.platform === "darwin") {
      await this.run("security", ["-i"], `add-generic-password -a paseo-nest -s ${id} -w ${encoded}
`);
      return { kind: "keychain", value: id };
    }
    throw new Error("\uC774 OS\uC5D0\uC11C\uB294 \uBC31\uC5C5 \uD0A4\uC758 \uBCF4\uC548 \uC800\uC7A5\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  }
  async reveal(reference) {
    if (reference.kind === "dpapi" && this.platform === "win32") return Buffer.from(await this.dpapi("Unprotect", reference.value), "base64").toString("utf8");
    const id = z3.string().uuid().parse(reference.value);
    if (reference.kind === "secret-service" && this.platform === "linux") return Buffer.from(await this.run("secret-tool", ["lookup", "application", "paseo-nest", "instance", id]), "base64").toString("utf8");
    if (reference.kind === "keychain" && this.platform === "darwin") return Buffer.from(await this.run("security", ["find-generic-password", "-a", "paseo-nest", "-s", id, "-w"]), "base64").toString("utf8");
    throw new Error("\uB2E4\uB978 OS\uB098 \uC0AC\uC6A9\uC790\uC5D0\uC11C \uC800\uC7A5\uD55C \uD0A4\uC785\uB2C8\uB2E4. \uBC31\uC5C5 \uC554\uD638\uB85C \uB2E4\uC2DC \uC5F0\uACB0\uD558\uC138\uC694.");
  }
  async remove(reference) {
    if (reference.kind === "dpapi") return;
    const id = z3.string().uuid().parse(reference.value);
    if (reference.kind === "secret-service" && this.platform === "linux") await this.run("secret-tool", ["clear", "application", "paseo-nest", "instance", id]);
    if (reference.kind === "keychain" && this.platform === "darwin") await this.run("security", ["delete-generic-password", "-a", "paseo-nest", "-s", id]);
  }
};

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/crypto.ts
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z as z6 } from "zod";

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/shared/model.ts
import { z as z5 } from "zod";

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/shared/host-settings.ts
import { z as z4 } from "zod";
var hostIdsSchema = z4.array(z4.string().min(1)).max(5e3).refine((ids) => new Set(ids).size === ids.length);
var hostPresentationSchema = z4.object({
  serverId: z4.string().min(1),
  label: z4.string().optional(),
  appearance: z4.record(z4.string(), z4.json()).optional()
}).strict();
var hostSettingsSchema = z4.object({
  hosts: z4.array(hostPresentationSchema).max(5e3).refine((hosts) => new Set(hosts.map((host) => host.serverId)).size === hosts.length),
  order: hostIdsSchema.nullable()
}).strict();
var hostPresentationCacheSchema = z4.object({
  presentation: hostSettingsSchema,
  knownHostIds: hostIdsSchema
}).strict();

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/shared/model.ts
var MAX_BYTES = 5 * 1024 * 1024;
var pluginId = z5.string().regex(/^[a-z][a-z0-9-]*$/).max(80);
var settingsId = z5.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(120);
var jsonObject2 = z5.record(z5.string(), z5.json());
var clientStateSchema = z5.object({
  hosts: z5.array(z5.object({
    serverId: z5.string().min(1),
    label: z5.string().optional(),
    password: z5.string().optional(),
    appearance: jsonObject2.optional(),
    lifecycle: jsonObject2.optional(),
    connections: z5.array(jsonObject2),
    preferredConnectionId: z5.string().nullable().optional(),
    createdAt: z5.string().optional(),
    updatedAt: z5.string().optional()
  })),
  preferences: z5.record(z5.string(), z5.string()),
  preferenceCoverage: z5.array(z5.string()).max(100).refine((keys) => new Set(keys).size === keys.length, "\uC911\uBCF5 \uC571 \uC124\uC815 \uBC94\uC704\uC785\uB2C8\uB2E4.").optional(),
  hostSettings: hostSettingsSchema.optional(),
  localHostIds: z5.array(z5.string().min(1)).max(5e3).refine((ids) => new Set(ids).size === ids.length).optional()
}).superRefine((client, context2) => {
  if (client.preferenceCoverage && Object.keys(client.preferences).some((key) => !client.preferenceCoverage.includes(key))) {
    context2.addIssue({ code: "custom", message: "\uC571 \uC124\uC815\uC774 \uC81C\uACF5\uB41C \uBC94\uC704\uC640 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
  }
});
var pluginSchema = z5.object({
  id: pluginId,
  enabled: z5.boolean(),
  files: z5.record(z5.string(), z5.string()).refine((files) => Object.keys(files).length <= 1500),
  settings: z5.record(z5.string(), z5.object({ version: z5.number().int().positive(), values: z5.json() }))
});
var scopeFlagsSchema = z5.object({
  hosts: z5.boolean(),
  preferences: z5.boolean(),
  providers: z5.boolean(),
  config: z5.boolean(),
  plugins: z5.boolean()
});
var snapshotSchema = z5.object({
  version: z5.union([z5.literal(1), z5.literal(2), z5.literal(3)]),
  createdAt: z5.string().datetime(),
  device: z5.string(),
  client: clientStateSchema,
  config: jsonObject2,
  plugins: z5.array(pluginSchema).max(100),
  scopes: scopeFlagsSchema.optional(),
  credentials: providerCredentialsSchema.optional()
}).superRefine((snapshot, context2) => {
  const providers = asProviders(snapshot.config.providers);
  for (const record2 of snapshot.credentials?.records ?? []) {
    for (const id of record2.providerIds) {
      if (!(id in providers) || providerFamily(id, providers) !== record2.vendor) context2.addIssue({ code: "custom", path: ["credentials"], message: "\uC778\uC99D \uBC31\uC5C5\uACFC \uD504\uB85C\uBC14\uC774\uB354 \uC124\uC815\uC758 \uC5F0\uACB0\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
    }
  }
});
var legacyPreferenceKeys = [
  "@paseo:app-settings",
  "@paseo:keyboard-shortcut-overrides",
  "@paseo:create-agent-preferences",
  "@paseo:preferred-editor",
  "@paseo:changes-preferences"
];
var preferenceKeys = [
  ...legacyPreferenceKeys,
  "sidebar-view",
  "sidebar-collapsed-sections",
  "sidebar-project-workspace-order"
];

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/crypto.ts
var derive = promisify(pbkdf2);
var iterations = 6e5;
var aad = Buffer.from("paseo-settings-sync:v1");
var envelopeSchema = z6.strictObject({
  version: z6.literal(1),
  cipher: z6.literal("aes-256-gcm"),
  kdf: z6.literal("pbkdf2-sha256"),
  iterations: z6.literal(iterations),
  salt: z6.string(),
  iv: z6.string(),
  tag: z6.string(),
  data: z6.string()
});
function decode(value, length) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("\uC554\uD638\uD654 \uB370\uC774\uD130 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const buffer = Buffer.from(value, "base64");
  if (length !== void 0 && buffer.length !== length) throw new Error("\uC554\uD638\uD654 \uB370\uC774\uD130 \uAE38\uC774\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return buffer;
}
async function seal(value, password, context2) {
  if (password.length < 12) throw new Error("\uBCF5\uAD6C \uC554\uD638\uB97C 12\uC790 \uC774\uC0C1 \uC785\uB825\uD558\uC138\uC694.");
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("\uBC31\uC5C5 \uD06C\uAE30\uB294 5 MiB\uB97C \uB118\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await derive(password, salt, iterations, 32, "sha256");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(context2);
    const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
    return JSON.stringify({
      version: 1,
      cipher: "aes-256-gcm",
      kdf: "pbkdf2-sha256",
      iterations,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64")
    });
  } finally {
    key.fill(0);
  }
}
async function open(raw, password, context2) {
  if (Buffer.byteLength(raw) > MAX_BYTES * 1.5) throw new Error("\uBC31\uC5C5 \uD06C\uAE30 \uC81C\uD55C\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
  const envelope = envelopeSchema.parse(JSON.parse(raw));
  const key = await derive(password, decode(envelope.salt, 16), iterations, 32, "sha256");
  let plain;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, decode(envelope.iv, 12));
    cipher.setAAD(context2);
    cipher.setAuthTag(decode(envelope.tag, 16));
    plain = Buffer.concat([cipher.update(decode(envelope.data)), cipher.final()]).toString("utf8");
  } catch {
    throw new Error("\uBCF5\uAD6C \uC554\uD638\uAC00 \uB2E4\uB974\uAC70\uB098 \uBC31\uC5C5\uC774 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
  } finally {
    key.fill(0);
  }
  try {
    return JSON.parse(plain);
  } catch {
    throw new Error("\uBCF5\uD638\uD654\uD55C \uBC31\uC5C5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  }
}
var localStateContext = Buffer.from("paseo-settings-sync:local-state:v1");
async function encryptLocal(value, password) {
  return seal(value, password, localStateContext);
}
async function decryptLocal(raw, password) {
  return open(raw, password, localStateContext);
}

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/claude-recovery-mutex.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import path4 from "node:path";
async function withClaudeRecoveryMutex(key, action) {
  if (process.platform !== "win32") return action(() => {
  });
  const name = "Local\\PaseoClaudeRecovery-" + createHash2("sha256").update(key.toLowerCase()).digest("hex");
  const script = "$ErrorActionPreference='Stop'; $mutex=New-Object Threading.Mutex($false,'" + name + "'); $held=$false; try { try {$held=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$held=$true}; if(-not $held){exit 2}; [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine()|Out-Null; } finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}";
  const child = spawn2(path4.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "pipe" });
  const failure = () => new Error("Claude \uC778\uC99D \uBCF5\uAD6C\uB97C \uB2E4\uB978 \uD504\uB85C\uC138\uC2A4\uAC00 \uC218\uD589 \uC911\uC774\uAC70\uB098 \uBCF5\uAD6C \uC7A0\uAE08\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD558\uC138\uC694.");
  let rejectReady, ready = false, alive = true;
  let output = "";
  const acquired = new Promise((resolve, reject) => {
    rejectReady = reject;
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.trim() === "locked") {
        ready = true;
        resolve();
      } else if (output.length > 100) reject(failure());
    });
    child.on("error", () => reject(failure()));
  });
  child.stderr.resume();
  child.stdin.on("error", () => rejectReady(failure()));
  const closed = new Promise((resolve) => child.on("close", (code) => {
    alive = false;
    if (!ready) rejectReady(failure());
    resolve(code);
  }));
  const timer = setTimeout(() => {
    rejectReady(failure());
    child.kill();
  }, 1e4);
  try {
    await acquired;
    clearTimeout(timer);
    const result = await action(() => {
      if (!alive) throw failure();
    });
    child.stdin.end("release\n");
    if (await closed !== 0) throw failure();
    return result;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await closed;
  }
}

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/claude-secure-journal.ts
var processSchema = z7.object({ pid: z7.number().int().positive(), start: z7.string().min(1).max(200) }).strict();
var writerSchema = processSchema.extend({ nonce: z7.string().uuid() }).strict();
var payloadSchema = z7.object({
  version: z7.literal(1),
  nonce: z7.string().uuid(),
  directory: z7.string(),
  service: z7.string(),
  context: z7.string(),
  owner: processSchema,
  locks: z7.array(z7.object({ file: z7.string(), birthtime: z7.number(), ino: z7.number() }).strict()).length(3),
  count: z7.number().int().min(0).max(MAX_CHUNKS),
  original: z7.record(z7.string(), z7.string().nullable()),
  previous: z7.string().max(1048576).nullable(),
  next: z7.string().max(1048576).nullable(),
  goal: z7.enum(["previous", "next"])
}).strict();
var envelopeSchema2 = z7.object({ version: z7.literal(1), nonce: z7.string().uuid(), key: secretReferenceSchema, ciphertext: z7.string() }).strict();
var changed = () => new Error("Claude \uC778\uC99D\uC774 \uB2E4\uB978 \uC791\uC5C5\uC5D0\uC11C \uBCC0\uACBD\uB418\uC5B4 \uC790\uB3D9 \uBCF5\uAD6C\uB85C \uB36E\uC5B4\uC4F0\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
var activeWriter = () => new Error("\uC774\uC804 Claude \uC778\uC99D \uC800\uC7A5 \uD504\uB85C\uC138\uC2A4\uAC00 \uC544\uC9C1 \uC2E4\uD589 \uC911\uC785\uB2C8\uB2E4. \uC800\uC7A5\uC744 \uB9C8\uCE5C \uB4A4 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD558\uC138\uC694.");
var hash2 = (value) => createHash3("sha256").update(value).digest("hex");
async function identifyProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process identity");
  if (process.platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; $idValue=[int]([Console]::In.ReadToEnd()); try { $processValue=[Diagnostics.Process]::GetProcessById($idValue); [Console]::Out.Write($processValue.StartTime.ToUniversalTime().Ticks.ToString()); } catch [ArgumentException] { [Console]::Out.Write('absent'); }";
    const result = await secretCommand(path5.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], String(pid));
    if (result === "absent") return null;
    if (!/^\d+$/.test(result)) throw new Error("Could not identify credential writer");
    return result;
  }
  if (process.platform === "linux") {
    try {
      const raw = await readFile2(`/proc/${pid}/stat`, "utf8");
      return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return pid === process.pid ? String(process.pid) : "present";
  } catch (error) {
    if (error.code === "ESRCH") return null;
    throw error;
  }
}
function names(count) {
  return [NAME, `${NAME}#m`, `${NAME}#p`, ...Array.from({ length: count }, (_, index) => `${NAME}#${index}`)];
}
function planned(raw, count) {
  const result = Object.fromEntries(names(count).map((name) => [name, null]));
  if (raw === null) return result;
  if (Buffer.byteLength(raw) <= CHUNK) {
    result[NAME] = raw;
    return result;
  }
  const encoded = Buffer.from(raw).toString("base64"), size = Math.ceil(encoded.length / CHUNK);
  if (size > count) throw new Error("Invalid journal layout");
  for (let index = 0; index < size; index++) result[`${NAME}#${index}`] = encoded.slice(index * CHUNK, (index + 1) * CHUNK);
  result[`${NAME}#m`] = JSON.stringify({ n: size, l: encoded.length });
  return result;
}
var ClaudeSecureJournal = class _ClaudeSecureJournal {
  constructor(directory, secrets = new CredentialStore(), identify = identifyProcess, guard = withClaudeRecoveryMutex) {
    this.directory = directory;
    this.secrets = secrets;
    this.identify = identify;
    this.guard = guard;
  }
  directory;
  secrets;
  identify;
  guard;
  static reaping = /* @__PURE__ */ new Map();
  active = /* @__PURE__ */ new Map();
  processStart;
  writer(service) {
    return this.active.get(service);
  }
  async file(profile) {
    return path5.join(this.directory, hash2(await realpath2(profile.directory) + "\0" + profile.service) + ".json");
  }
  writerFile(loaded) {
    return loaded.file + ".writer-" + loaded.payload.nonce + ".json";
  }
  async owner() {
    const start = await (this.processStart ??= this.identify(process.pid));
    if (!start) throw new Error("Claude \uC778\uC99D \uC800\uC7A5 \uD504\uB85C\uC138\uC2A4 \uC18C\uC720\uAD8C\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return { pid: process.pid, start };
  }
  async safeRead(file, max) {
    const directory = await lstat3(path5.dirname(file)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!directory) return null;
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe credential journal directory");
    const info = await lstat3(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("Unsafe credential journal");
    return readFile2(file, "utf8");
  }
  async atomic(file, raw) {
    await mkdir3(path5.dirname(file), { recursive: true, mode: 448 });
    const directory = await lstat3(path5.dirname(file));
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("Unsafe credential journal directory");
    const temporary = file + "." + randomUUID3() + ".tmp";
    try {
      const handle = await open2(temporary, "wx", 384);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename2(temporary, file);
    } finally {
      await rm2(temporary, { force: true });
    }
  }
  async load(profile) {
    const file = await this.file(profile), raw = await this.safeRead(file, 8 * 1024 * 1024);
    if (raw === null) return null;
    const envelope = envelopeSchema2.parse(JSON.parse(raw));
    const password = await this.secrets.reveal(envelope.key);
    const payload = payloadSchema.parse(await decryptLocal(envelope.ciphertext, password));
    const expected = names(payload.count).sort();
    if (payload.nonce !== envelope.nonce || payload.directory !== await realpath2(profile.directory) || payload.service !== profile.service || JSON.stringify(Object.keys(payload.original).sort()) !== JSON.stringify(expected)) throw changed();
    return { file, raw, envelope, payload, password };
  }
  async persist(loaded) {
    if (await this.safeRead(loaded.file, 8 * 1024 * 1024) !== loaded.raw) throw changed();
    loaded.envelope.ciphertext = await encryptLocal(loaded.payload, loaded.password);
    const raw = JSON.stringify(loaded.envelope);
    if (await this.safeRead(loaded.file, 8 * 1024 * 1024) !== loaded.raw) throw changed();
    await this.atomic(loaded.file, raw);
    loaded.raw = raw;
  }
  async writerAlive(loaded) {
    const raw = await this.safeRead(this.writerFile(loaded), 8192);
    if (raw === null) return false;
    const writer = writerSchema.parse(JSON.parse(raw));
    if (writer.nonce !== loaded.payload.nonce) throw changed();
    if (await this.identify(writer.pid) === writer.start) return true;
    await rm2(this.writerFile(loaded));
    return false;
  }
  async finish(loaded) {
    if (await this.writerAlive(loaded)) throw activeWriter();
    if (await this.safeRead(loaded.file, 8 * 1024 * 1024) !== loaded.raw) throw changed();
    await rm2(loaded.file);
    await this.secrets.remove(loaded.envelope.key);
  }
  async beforeLock(profile) {
    const file = await this.file(profile);
    if (await this.safeRead(file, 8 * 1024 * 1024) === null) return;
    const preceding = _ClaudeSecureJournal.reaping.get(file);
    const pending = (preceding ?? Promise.resolve()).catch(() => {
    }).then(() => this.guard(file, (verify) => this.reap(profile, verify)));
    _ClaudeSecureJournal.reaping.set(file, pending);
    try {
      await pending;
    } finally {
      if (_ClaudeSecureJournal.reaping.get(file) === pending) _ClaudeSecureJournal.reaping.delete(file);
    }
  }
  async reap(profile, verify) {
    const loaded = await this.load(profile);
    if (!loaded || await this.identify(loaded.payload.owner.pid) === loaded.payload.owner.start || await this.writerAlive(loaded)) return;
    const resolved = await realpath2(profile.directory);
    const expected = [path5.join(resolved, ".oauth_refresh.lock"), resolved + ".lock", path5.join(resolved, ".storage-write.lock")];
    if (loaded.payload.locks.some((entry, index) => entry.file !== expected[index])) throw changed();
    const matches = async (entry) => {
      const info = await lstat3(entry.file).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return !info ? "missing" : info.isDirectory() && !info.isSymbolicLink() && info.birthtimeMs === entry.birthtime && info.ino === entry.ino ? "owned" : "foreign";
    };
    for (const entry of loaded.payload.locks) if (await matches(entry) === "foreign") return;
    for (const entry of [...loaded.payload.locks].reverse()) if (await matches(entry) === "owned") {
      verify();
      await rmdir2(entry.file);
    }
  }
  async recover(profile, io, retarget) {
    const loaded = await this.load(profile);
    if (!loaded) return false;
    await io.verify();
    if (await this.writerAlive(loaded)) throw activeWriter();
    if (loaded.payload.context !== await io.context()) {
      await this.finish(loaded);
      if (retarget) throw changed();
      return true;
    }
    if (retarget) {
      if (retarget.raw !== loaded.payload.previous && retarget.raw !== loaded.payload.next) throw changed();
      loaded.payload.goal = retarget.raw === loaded.payload.next ? "next" : "previous";
    }
    const previous = planned(loaded.payload.previous, loaded.payload.count), next = planned(loaded.payload.next, loaded.payload.count);
    const current = Object.fromEntries(await Promise.all(names(loaded.payload.count).map(async (name) => [name, await io.readEntry(name)])));
    const compatible = Object.entries(current).every(([name, value]) => (/* @__PURE__ */ new Set([null, loaded.payload.original[name], previous[name], next[name], ...name === `${NAME}#p` ? [String(loaded.payload.count)] : []])).has(value));
    const desired = loaded.payload[loaded.payload.goal];
    const empty = Object.values(current).every((value) => value === null);
    if (!compatible || empty && desired !== null) {
      const raw = await io.readComplete();
      if (raw !== null) {
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw changed();
      }
      await this.finish(loaded);
      if (retarget) throw changed();
      return true;
    }
    const desiredLayout = planned(desired, loaded.payload.count);
    loaded.payload.owner = await this.owner();
    loaded.payload.locks = io.locks();
    await this.persist(loaded);
    await io.verify();
    if (loaded.payload.context !== await io.context()) throw changed();
    for (const [name, value] of Object.entries(current)) if (await io.readEntry(name) !== value) throw changed();
    if (!Object.entries(current).every(([name, value]) => value === desiredLayout[name])) {
      this.active.set(profile.service, { file: this.writerFile(loaded), nonce: loaded.payload.nonce, owner: loaded.payload.owner });
      try {
        await io.writeComplete(desired, retarget?.beforeMutation);
      } finally {
        this.active.delete(profile.service);
      }
    }
    await io.verify();
    for (const [name, value] of Object.entries(desiredLayout)) if (await io.readEntry(name) !== value) throw changed();
    await this.finish(loaded);
    return true;
  }
  async write(profile, io, raw, expected, beforeMutation) {
    const existed = await this.safeRead(await this.file(profile), 8 * 1024 * 1024) !== null;
    if (existed) {
      await this.recover(profile, io, { raw, beforeMutation });
      if (await io.readComplete() === raw) return;
    }
    const previous = await io.readComplete();
    if (expected !== void 0 && previous !== expected) throw changed();
    const meta = await io.readEntry(`${NAME}#m`), pending = await io.readEntry(`${NAME}#p`);
    const oldCount = meta ? JSON.parse(meta).n : 0, pendingCount = pending === null ? 0 : Number(pending);
    const nextCount = raw !== null && Buffer.byteLength(raw) > CHUNK ? Math.ceil(Buffer.from(raw).toString("base64").length / CHUNK) : 0;
    const count = Math.max(oldCount, pendingCount, nextCount);
    if (!Number.isInteger(count) || count < 0 || count > MAX_CHUNKS) throw changed();
    const original = Object.fromEntries(await Promise.all(names(count).map(async (name) => [name, await io.readEntry(name)])));
    const nonce = randomUUID3(), password = randomBytes2(32).toString("hex");
    const key = await this.secrets.protect(password);
    const payload = { version: 1, nonce, directory: await realpath2(profile.directory), service: profile.service, context: await io.context(), owner: await this.owner(), locks: io.locks(), count, original, previous, next: raw, goal: "next" };
    const envelope = { version: 1, nonce, key, ciphertext: await encryptLocal(payload, password) };
    const file = await this.file(profile), encoded = JSON.stringify(envelope);
    await io.verify();
    if (await this.safeRead(file, 8 * 1024 * 1024) !== null) throw changed();
    await this.atomic(file, encoded);
    const loaded = { file, raw: encoded, envelope, payload, password };
    let started = false;
    this.active.set(profile.service, { file: this.writerFile(loaded), nonce, owner: payload.owner });
    try {
      await io.verify();
      if (payload.context !== await io.context()) throw changed();
      for (const [name, value] of Object.entries(original)) if (await io.readEntry(name) !== value) throw changed();
      await io.writeComplete(raw, () => {
        started = true;
        beforeMutation?.();
      });
      await io.verify();
      for (const [name, value] of Object.entries(planned(raw, count))) if (await io.readEntry(name) !== value) throw changed();
      await this.finish(loaded);
    } catch (error) {
      if (!started) await this.finish(loaded);
      throw error;
    } finally {
      this.active.delete(profile.service);
    }
  }
};

// ../../../파세오/settings-sync/.check/release-0.3.10-32479f22be0f460d87b8df70b7ea6cbd/settings-sync/server/provider-credentials.ts
var LIMIT2 = 1048576;
var CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
var object3 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var hash3 = (value) => createHash4("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
var concurrentAuthentication = () => new Error("\uBCF5\uC6D0 \uC900\uBE44 \uC911 \uACC4\uC815 \uB610\uB294 \uC778\uC99D\uC774 \uB2E4\uB978 \uD504\uB85C\uC138\uC2A4\uC5D0\uC11C \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uCD5C\uC2E0 \uC778\uC99D\uC744 \uBCF4\uC874\uD588\uC73C\uB2C8 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD558\uC138\uC694.");
var authState = (vendor, raw) => JSON.stringify(raw === null ? null : normalizeVendorCredential(vendor, parseObject(raw, vendor)));
function parseObject(raw, label) {
  try {
    if (Buffer.byteLength(raw, "utf8") > LIMIT2) throw new Error();
    const value = JSON.parse(raw);
    if (!object3(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} \uC778\uC99D \uB370\uC774\uD130\uAC00 \uC190\uC0C1\uB418\uC5C8\uAC70\uB098 \uC9C0\uC6D0\uD558\uB294 \uD06C\uAE30\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.`);
  }
}
async function readKnown2(file) {
  try {
    let parent = path6.dirname(path6.resolve(file));
    while (true) {
      const info = await lstat4(parent).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("unsafe");
      const next = path6.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    const stat = await lstat4(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > LIMIT2) throw new Error("unsafe");
    return { raw: await readFile3(file, "utf8"), updatedAt: Math.max(0, Math.trunc(stat.mtimeMs)) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uD30C\uC77C\uC744 \uC548\uC804\uD558\uAC8C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD30C\uC77C \uAD8C\uD55C\uACFC \uC2EC\uBCFC\uB9AD \uB9C1\uD06C\uB97C \uD655\uC778\uD558\uC138\uC694.");
  }
}
function providerProfileDirectory(home, id) {
  if (!/^(claude|codex|cursor|opencode|pi)-[a-f0-9]{24}$/.test(id)) throw new Error("\uC798\uBABB\uB41C \uD504\uB85C\uBC14\uC774\uB354 \uD504\uB85C\uD544 ID\uC785\uB2C8\uB2E4.");
  return path6.join(path6.resolve(home), "settings-sync", "provider-profiles", id);
}
async function managedDirectory(home, id) {
  const directory = providerProfileDirectory(home, id);
  let current = path6.resolve(home);
  for (const part of ["settings-sync", "provider-profiles", id]) {
    current = path6.join(current, part);
    await mkdir4(current, { recursive: true, mode: 448 });
    const stat = await lstat4(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("\uC778\uC99D \uD504\uB85C\uD544 \uACBD\uB85C\uC5D0 \uC2EC\uBCFC\uB9AD \uB9C1\uD06C\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }
  return directory;
}
function expand2(value, fallback, userHome) {
  const raw = value === void 0 || value === "" ? fallback : value;
  if (raw.startsWith("@paseo-profile:")) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uD504\uB85C\uD544 \uACBD\uB85C\uB97C \uBA3C\uC800 \uD604\uC7AC \uAE30\uAE30\uC758 \uACBD\uB85C\uB85C \uBCC0\uD658\uD558\uC138\uC694.");
  return path6.resolve(raw === "~" ? userHome : raw.startsWith("~/") || raw.startsWith("~\\") ? path6.join(userHome, raw.slice(2)) : raw);
}
function metadata(config) {
  return {
    ...object3(config.oauthAccount) ? { oauthAccount: config.oauthAccount } : {},
    ...typeof config.hasCompletedOnboarding === "boolean" ? { hasCompletedOnboarding: config.hasCompletedOnboarding } : {},
    ...typeof config.lastOnboardingVersion === "string" ? { lastOnboardingVersion: config.lastOnboardingVersion } : {}
  };
}
function jwtClaims(value) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8"));
    return object3(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function identity2(vendor, credential, meta) {
  if (vendor === "claude") {
    const account = meta.oauthAccount ?? {};
    const oauth2 = object3(credential.claudeAiOauth) ? credential.claudeAiOauth : {};
    const claims2 = jwtClaims(oauth2.accessToken);
    const stable2 = account.accountUuid ?? account.accountId ?? claims2.sub ?? account.emailAddress;
    return hash3([vendor, stable2 ?? oauth2.refreshToken ?? oauth2.accessToken, account.organizationUuid ?? account.organizationId ?? null]);
  }
  const tokens = object3(credential.tokens) ? credential.tokens : {};
  const claims = jwtClaims(tokens.id_token ?? tokens.access_token);
  if (credential.auth_mode === "apikey" || credential.auth_mode == null && typeof credential.OPENAI_API_KEY === "string" && credential.OPENAI_API_KEY) return hash3([vendor, credential.OPENAI_API_KEY]);
  const provenance = object3(tokens.oauth_provenance) ? tokens.oauth_provenance : {};
  return hash3([vendor, tokens.account_id ?? claims.sub ?? credential.OPENAI_API_KEY ?? tokens.refresh_token ?? tokens.access_token, ...tokens.login_owner_id != null || tokens.oauth_provenance != null ? [tokens.login_owner_id ?? null, provenance.issuer ?? null, provenance.client_id ?? null] : []]);
}
function expiresAt2(vendor, credential) {
  if (vendor === "claude") {
    const oauth2 = credential.claudeAiOauth;
    return object3(oauth2) && typeof oauth2.expiresAt === "number" && Number.isFinite(oauth2.expiresAt) ? oauth2.expiresAt : null;
  }
  if (credential.auth_mode === "apikey" || credential.auth_mode == null && typeof credential.OPENAI_API_KEY === "string" && credential.OPENAI_API_KEY) return null;
  const tokens = object3(credential.tokens) ? credential.tokens : {};
  const claims = jwtClaims(tokens.access_token);
  return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1e3 : null;
}
function claudeCredentialService(profile, defaultProfile) {
  return `Claude Code-credentials${defaultProfile ? "" : `-${hash3(profile.normalize("NFC")).slice(0, 8)}`}`;
}
var WINDOWS_CREDENTIAL_SCRIPT = String.raw`$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.IO;
using System.Text;
public static class PaseoProviderCredentials {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadNative(string target,UInt32 type,UInt32 flags,out IntPtr value);
 [DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteNative(ref Credential value,UInt32 flags);
 [DllImport("advapi32.dll",EntryPoint="CredDeleteW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteNative(string target,UInt32 type,UInt32 flags);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static object Read(string target) { IntPtr pointer; if(!ReadNative(target,1,0,out pointer)) { if(Marshal.GetLastWin32Error()==1168)return null; throw new Win32Exception(); } try { var credential=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential)); if(credential.CredentialBlobSize>1048576)throw new Exception(); var bytes=new byte[credential.CredentialBlobSize]; Marshal.Copy(credential.CredentialBlob,bytes,0,bytes.Length); long stamp=((long)(uint)credential.LastWritten.dwHighDateTime<<32)|(uint)credential.LastWritten.dwLowDateTime; return new {value=Convert.ToBase64String(bytes),updatedAt=(DateTime.FromFileTimeUtc(stamp)-new DateTime(1970,1,1)).TotalMilliseconds,persistence=credential.Persist}; } finally { CredFree(pointer); } }
 static void WriteWithPersistence(string target,string encoded,UInt32 persistence) { byte[] bytes=Convert.FromBase64String(encoded); IntPtr pointer=Marshal.AllocHGlobal(bytes.Length); try { Marshal.Copy(bytes,0,pointer,bytes.Length); var credential=new Credential { Type=1,TargetName=target,UserName="claude-code-user",CredentialBlobSize=(UInt32)bytes.Length,CredentialBlob=pointer,Persist=persistence }; if(!WriteNative(ref credential,0))throw new Win32Exception(); } finally { for(int i=0;i<bytes.Length;i++)Marshal.WriteByte(pointer,i,0); Marshal.FreeHGlobal(pointer); Array.Clear(bytes,0,bytes.Length); } }
 public static void Write(string target,string encoded) { WriteWithPersistence(target,encoded,3); }
 public static void Normalize(string target,string encoded) { WriteWithPersistence(target,encoded,3); WriteWithPersistence(target,encoded,2); Delete(target); WriteWithPersistence(target,encoded,3); }
 public static void Delete(string target) { if(!DeleteNative(target,1,0)&&Marshal.GetLastWin32Error()!=1168)throw new Win32Exception(); }
 public static void Track(string file,string text) { string temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp"; try { byte[] bytes=Encoding.UTF8.GetBytes(text); using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { stream.Write(bytes,0,bytes.Length); stream.Flush(true); } File.Move(temporary,file); } finally { if(File.Exists(temporary))File.Delete(temporary); } }
}
'@
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
if($request.operation -ne 'read' -and $null -ne $request.writer) {
 $writer=$request.writer
 $stamp=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()
 [PaseoProviderCredentials]::Track($writer.file,(@{pid=$PID;start=$stamp;nonce=$writer.nonce}|ConvertTo-Json -Compress))
 try {
  # Publish the child first, then check its parent. A late-starting orphan must never mutate.
  $parent=[Diagnostics.Process]::GetProcessById([int]$writer.owner.pid)
  if($parent.StartTime.ToUniversalTime().Ticks.ToString() -ne $writer.owner.start){throw 'owner'}
  switch($request.operation) {
   'write' { [PaseoProviderCredentials]::Write($request.target,$request.value) }
   'normalize' { [PaseoProviderCredentials]::Normalize($request.target,$request.value) }
   'delete' { [PaseoProviderCredentials]::Delete($request.target) }
   default { throw 'operation' }
  }
 } finally { [IO.File]::Delete($writer.file) }
} else {
switch($request.operation) {
 'read' { $result=[PaseoProviderCredentials]::Read($request.target); if($null -eq $result){[Console]::Out.Write('null')}else{[Console]::Out.Write(($result|ConvertTo-Json -Compress))} }
 'write' { [PaseoProviderCredentials]::Write($request.target,$request.value) }
 'normalize' { [PaseoProviderCredentials]::Normalize($request.target,$request.value) }
 'delete' { [PaseoProviderCredentials]::Delete($request.target) }
 default { throw 'operation' }
}
}
} catch { [Console]::Error.Write('Provider credential store failed.'); exit 1 }`;
var runProviderSecret = (executable, args, input) => new Promise((resolve, reject) => {
  const child = spawn3(executable, args, { windowsHide: true, stdio: "pipe" });
  const chunks = [];
  let bytes = 0;
  let finished = false;
  let failed = false;
  const abort = () => {
    if (finished || failed) return;
    failed = true;
    child.kill();
  };
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (ok) resolve(Buffer.concat(chunks).toString("utf8").trim());
    else reject(new Error("Windows \uC790\uACA9\uC99D\uBA85 \uC800\uC7A5\uC18C\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uAC19\uC740 Windows \uC0AC\uC6A9\uC790\uB85C Paseo\uB97C \uC2E4\uD589\uD558\uACE0 \uC790\uACA9\uC99D\uBA85 \uAD00\uB9AC\uC790 \uC11C\uBE44\uC2A4\uB97C \uD655\uC778\uD558\uC138\uC694."));
  };
  const timer = setTimeout(abort, 2e4);
  child.stdout.on("data", (chunk) => {
    if (failed) return;
    bytes += chunk.length;
    if (bytes > LIMIT2 * 2) abort();
    else chunks.push(chunk);
  });
  child.stderr.resume();
  child.on("error", abort);
  child.on("close", (code) => finish(code === 0 && !failed));
  child.stdin.on("error", abort);
  child.stdin.end(input);
});
var WindowsProviderSecureStore = class {
  constructor(run = runProviderSecret, systemRoot = process.env.SystemRoot ?? "C:\\Windows", reader) {
    this.run = run;
    this.systemRoot = systemRoot;
    this.reader = reader;
  }
  run;
  systemRoot;
  reader;
  writerTracker;
  setWriterTracker(tracker) {
    this.writerTracker = tracker;
  }
  async command(operation, service, name, value) {
    const executable = path6.win32.join(this.systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const writer = operation === "read" ? void 0 : this.writerTracker?.(service);
    const oneShot = () => this.run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64")], JSON.stringify({ operation, target: `${service}/${name}`, ...writer ? { writer } : {}, ...value === void 0 ? {} : { value: Buffer.from(value, "utf8").toString("base64") } }));
    // Only reads use the resident helper, and whenever it cannot answer, the one-shot process decides.
    if (operation === "read" && this.reader) return this.reader.read(`${service}/${name}`).catch(oneShot);
    return oneShot();
  }
  async read(service, name) {
    const raw = await this.command("read", service, name);
    if (raw === "null") return null;
    try {
      const result = JSON.parse(raw);
      if (!object3(result) || typeof result.value !== "string" || typeof result.updatedAt !== "number") throw new Error();
      return { value: Buffer.from(result.value, "base64").toString("utf8"), updatedAt: Math.max(0, result.updatedAt), ...typeof result.persistence === "number" ? { persistence: result.persistence } : {} };
    } catch {
      throw new Error("Windows \uC790\uACA9\uC99D\uBA85 \uC800\uC7A5\uC18C \uC751\uB2F5\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
  }
  async write(service, name, value) {
    await this.command("write", service, name, value);
  }
  // Call only while holding the CLI storage locks and retaining a complete fallback.
  async normalizePersistence(service, name, value) {
    await this.command("normalize", service, name, value);
  }
  async remove(service, name) {
    await this.command("delete", service, name);
  }
};
async function readSecure(store, service) {
  const meta = await store.read(service, `${NAME}#m`);
  if (!meta) return store.read(service, NAME);
  let info;
  try {
    info = JSON.parse(meta.value);
    if (!Number.isInteger(info.n) || info.n < 1 || info.n > MAX_CHUNKS || !Number.isInteger(info.l) || info.l < 1 || info.l > info.n * CHUNK) throw new Error();
  } catch {
    throw new Error("Claude Windows \uC778\uC99D \uC800\uC7A5\uC18C\uC758 \uBD84\uD560 \uC815\uBCF4\uAC00 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4. Claude CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.");
  }
  const chunks = await Promise.all(Array.from({ length: info.n }, (_, index) => store.read(service, `${NAME}#${index}`)));
  const encoded = chunks.map((chunk) => chunk?.value ?? "").join("");
  if (chunks.some((chunk) => !chunk) || encoded.length !== info.l) throw new Error("Claude Windows \uC778\uC99D \uC800\uC7A5\uC18C\uC758 \uC77C\uBD80 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. Claude CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.");
  return { value: Buffer.from(encoded, "base64").toString("utf8"), updatedAt: Math.max(meta.updatedAt, ...chunks.map((chunk) => chunk.updatedAt)) };
}
async function writeSecure(store, service, raw, expected, beforeMutation, verify = async () => {
}) {
  await verify();
  const previous = await store.read(service, `${NAME}#m`);
  let count = 0;
  if (previous) {
    try {
      const info = JSON.parse(previous.value);
      count = Number.isInteger(info.n) ? Math.min(MAX_CHUNKS, Math.max(0, info.n)) : 0;
    } catch {
      throw new Error("Claude Windows \uC778\uC99D \uC800\uC7A5\uC18C\uAC00 \uC190\uC0C1\uB418\uC5B4 \uB36E\uC5B4\uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
  }
  const pending = await store.read(service, `${NAME}#p`);
  if (pending) {
    const unfinished = Number(pending.value);
    if (!Number.isInteger(unfinished) || unfinished < 0 || unfinished > MAX_CHUNKS) throw new Error("Claude Windows \uC778\uC99D \uC800\uC7A5\uC18C\uC758 \uC9C4\uD589 \uC815\uBCF4\uAC00 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
    count = Math.max(count, unfinished);
  }
  if (expected !== void 0 && ((await readSecure(store, service))?.value ?? null) !== expected) throw concurrentAuthentication();
  beforeMutation?.();
  const mutate = async (action) => {
    await verify();
    await action();
    await verify();
  };
  if (raw !== null && Buffer.byteLength(raw, "utf8") > CHUNK) {
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    const next = Math.ceil(encoded.length / CHUNK);
    if (next > MAX_CHUNKS) throw new Error("Claude Windows \uC778\uC99D \uB370\uC774\uD130\uAC00 \uC800\uC7A5\uC18C \uC81C\uD55C\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
    await mutate(() => store.write(service, `${NAME}#p`, String(Math.max(count, next))));
    for (let index = 0; index < next; index++) await mutate(() => store.write(service, `${NAME}#${index}`, encoded.slice(index * CHUNK, (index + 1) * CHUNK)));
    await mutate(() => store.write(service, `${NAME}#m`, JSON.stringify({ n: next, l: encoded.length })));
    await mutate(() => store.remove(service, NAME));
    for (let index = next; index < count; index++) await mutate(() => store.remove(service, `${NAME}#${index}`));
  } else {
    if (count) await mutate(() => store.write(service, `${NAME}#p`, String(count)));
    if (raw === null) await mutate(() => store.remove(service, NAME));
    else await mutate(() => store.write(service, NAME, raw));
    await mutate(() => store.remove(service, `${NAME}#m`));
    for (let index = 0; index < count; index++) await mutate(() => store.remove(service, `${NAME}#${index}`));
  }
  await mutate(() => store.remove(service, `${NAME}#p`));
}
var ProviderCredentialSync = class {
  home;
  userHome;
  platform;
  env;
  secure;
  journal;
  preparedClaudeLocks = /* @__PURE__ */ new Map();
  constructor(options) {
    this.home = options.home;
    this.userHome = options.userHome ?? homedir2();
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.secure = options.secure ?? (this.platform === "win32" ? new WindowsProviderSecureStore(options.run, this.env.SystemRoot, options.reader) : void 0);
    this.journal = options.journal ?? (this.platform === "win32" && process.platform === "win32" && !options.secure && !options.run ? new ClaudeSecureJournal(path6.join(this.home, "settings-sync", "claude-restore-journal")) : void 0);
    if (this.journal && this.secure instanceof WindowsProviderSecureStore) this.secure.setWriterTracker((service) => this.journal.writer(service));
  }
  journalIO(profile, lock) {
    return {
      readEntry: async (name) => (await this.secure.read(profile.secureService, name))?.value ?? null,
      readComplete: async () => (await readSecure(this.secure, profile.secureService))?.value ?? null,
      writeComplete: (raw, beforeMutation) => writeSecure(this.secure, profile.secureService, raw, void 0, beforeMutation, lock.verify),
      context: async () => {
        const file = await readKnown2(path6.join(profile.configDirectory, ".claude.json"));
        const account = file ? parseObject(file.raw, "Claude \uACC4\uC815 \uC124\uC815").oauthAccount : null;
        return hash3(object3(account) ? [account.accountUuid ?? account.accountId ?? null, account.organizationUuid ?? account.organizationId ?? null, account.emailAddress ?? null] : null);
      },
      verify: lock.verify,
      locks: lock.snapshot
    };
  }
  vendorOptions() {
    return { home: this.home, userHome: this.userHome, platform: this.platform, env: this.env };
  }
  effectiveEnvironment(id, providers, visited = /* @__PURE__ */ new Set()) {
    if (visited.has(id)) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC0C1\uC18D \uC124\uC815\uC5D0 \uC21C\uD658\uC774 \uC788\uC2B5\uB2C8\uB2E4.");
    visited.add(id);
    const entry = object3(providers[id]) ? providers[id] : {};
    const base = typeof entry.extends === "string" ? this.effectiveEnvironment(entry.extends, providers, visited) : this.env;
    return Object.fromEntries(Object.entries({ ...base, ...object3(entry.env) ? entry.env : {} }).filter((entry2) => typeof entry2[1] === "string"));
  }
  profiles(providers) {
    const result = /* @__PURE__ */ new Map();
    for (const id of /* @__PURE__ */ new Set(["claude", "codex", ...Object.keys(providers)])) {
      const vendor = providerFamily(id, asProviders(providers));
      if (vendor !== "claude" && vendor !== "codex") continue;
      const env = this.effectiveEnvironment(id, providers);
      const fallback = path6.join(this.userHome, vendor === "claude" ? ".claude" : ".codex");
      const directory = expand2(vendor === "claude" ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME, fallback, this.userHome);
      const configDirectory = vendor === "claude" ? expand2(env.CLAUDE_CONFIG_DIR, this.userHome, this.userHome) : directory;
      const defaultProfile = vendor === "claude" && (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== void 0 ? !env.CLAUDE_SECURESTORAGE_CONFIG_DIR : !env.CLAUDE_CONFIG_DIR);
      const secureService = vendor === "claude" && this.platform === "win32" ? claudeCredentialService(env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? directory, defaultProfile) : null;
      const key = `${vendor}:${directory}:${secureService ?? ""}`;
      const previous = result.get(key);
      if (previous) previous.providerIds.push(id);
      else result.set(key, { vendor, providerIds: [id], directory, configDirectory, defaultProfile, secureService, env });
    }
    return [...result.values()];
  }
  async record(profile, locked = false) {
    if (profile.vendor !== "claude" || locked) return this.readRecord(profile);
    const prepared = this.preparedClaudeLocks.get(profile.directory);
    if (prepared) {
      await prepared.verify();
      const result = await this.readRecord(profile);
      await prepared.verify();
      return result;
    }
    const directory = await lstat4(profile.directory).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!directory) return this.readRecord(profile);
    if (this.journal && profile.secureService) await this.journal.beforeLock({ directory: profile.directory, service: profile.secureService });
    const lock = await lockClaudeAuthentication(profile.directory);
    try {
      await lock.verify();
      if (this.journal && profile.secureService) await this.journal.recover({ directory: profile.directory, service: profile.secureService }, this.journalIO(profile, lock));
      const result = await this.readRecord(profile);
      await lock.verify();
      return result;
    } finally {
      await lock.release();
    }
  }
  async readRecord(profile) {
    const { vendor, directory, configDirectory } = profile;
    const metaFile = vendor === "claude" ? await readKnown2(path6.join(configDirectory, ".claude.json")) : null;
    const config = metaFile ? parseObject(metaFile.raw, "Claude \uACC4\uC815 \uC124\uC815") : {};
    const meta = metadata(config);
    let source = null;
    let store = "none";
    if (vendor === "claude" && this.platform === "win32") {
      const forced = profile.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === "1";
      const legacy = forced ? null : await readKnown2(path6.join(directory, ".config.json"));
      const backend = legacy?.raw ? parseObject(legacy.raw, "Claude \uC800\uC7A5\uC18C \uC124\uC815") : config;
      const enabled = forced || object3(backend.cachedGrowthBookFeatures) && backend.cachedGrowthBookFeatures.tengu_windows_credman === true;
      if (enabled) {
        if (!this.secure) throw new Error("Windows Claude \uC778\uC99D \uC800\uC7A5\uC18C \uC5B4\uB311\uD130\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        const secured = await readSecure(this.secure, profile.secureService);
        if (secured) {
          source = { raw: secured.value, updatedAt: Math.trunc(secured.updatedAt) };
          store = "windows-credman";
        }
      }
    }
    if (!source) {
      source = await readKnown2(path6.join(directory, vendor === "claude" ? ".credentials.json" : "auth.json"));
      if (source) store = "file";
    }
    if (vendor === "claude" && this.platform === "win32" && store === "file" && source) {
      const file = parseObject(source.raw, "Claude");
      const oauth2 = file?.claudeAiOauth;
      const missing = oauth2 == null || object3(oauth2) && (oauth2.accessToken == null || typeof oauth2.accessToken === "string" && !oauth2.accessToken.trim());
      if (missing && this.secure) {
        const secured = await readSecure(this.secure, profile.secureService);
        if (secured) {
          source = { raw: secured.value, updatedAt: Math.trunc(secured.updatedAt) };
          store = "windows-credman";
        }
      }
    }
    if (!source) {
      if (vendor === "claude" && this.platform === "darwin" && config.oauthAccount) throw new Error("\uC774 Claude \uACC4\uC815\uC740 macOS \uD0A4\uCCB4\uC778\uC5D0 \uC800\uC7A5\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. \uC774 \uBC84\uC804\uC740 \uD574\uB2F9 \uD0A4\uCCB4\uC778 \uB0B4\uBCF4\uB0B4\uAE30\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. CLI\uC758 \uC7A5\uAE30 \uC2E4\uD589 \uD1A0\uD070\uC744 \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC5D0 \uC9C0\uC815\uD558\uC138\uC694.");
      if (vendor === "codex") {
        const configuration = await readKnown2(path6.join(directory, "config.toml"));
        const global = configuration?.raw.split(/^\s*\[/m)[0] ?? "";
        if (/^\s*cli_auth_credentials_store\s*=\s*["']keyring["']\s*(?:#.*)?$/m.test(global)) throw new Error("Codex\uAC00 OS \uD0A4\uB9C1 \uC778\uC99D \uC800\uC7A5\uC18C\uB97C \uC0AC\uC6A9\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uC774 \uBC84\uC804\uC740 Codex \uD0A4\uB9C1 \uB0B4\uBCF4\uB0B4\uAE30\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. Codex\uC758 cli_auth_credentials_store\uB97C file\uB85C \uC124\uC815\uD55C \uB4A4 CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.");
      }
      return { record: null, store: "none" };
    }
    const credential = parseObject(source.raw, vendor);
    if (vendor === "claude") {
      const oauth2 = credential.claudeAiOauth;
      if (oauth2 == null) return { record: null, store };
      if (!object3(oauth2)) throw new Error("Claude OAuth \uC778\uC99D \uB370\uC774\uD130\uC758 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.");
      if (oauth2.accessToken == null || typeof oauth2.accessToken === "string" && !oauth2.accessToken.trim()) return { record: null, store };
      if (typeof oauth2.accessToken !== "string") throw new Error("Claude OAuth \uC778\uC99D \uD1A0\uD070\uC758 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. CLI\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.");
    }
    const ids = [...profile.providerIds].sort();
    const primary = ids.includes(vendor) ? vendor : ids[0];
    const id = `${vendor}-${hash3(primary).slice(0, 24)}`;
    const expiry = expiresAt2(vendor, credential);
    const updatedAt = vendor === "codex" && typeof credential.last_refresh === "string" && Number.isFinite(Date.parse(credential.last_refresh)) ? Date.parse(credential.last_refresh) : vendor === "claude" && expiry !== null ? expiry : source.updatedAt;
    const record2 = { id, vendor, providerIds: ids, credential, metadata: meta, identity: identity2(vendor, credential, meta), updatedAt, expiresAt: expiry };
    const parsed = providerCredentialsSchema.safeParse({ version: 1, records: [record2] });
    if (!parsed.success) throw new Error(`${vendor} \uC778\uC99D \uD615\uC2DD\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. CLI\uB97C \uC5C5\uB370\uC774\uD2B8\uD558\uAC70\uB098 \uD574\uB2F9 \uD504\uB85C\uBC14\uC774\uB354\uC5D0\uC11C \uB2E4\uC2DC \uB85C\uADF8\uC778\uD558\uC138\uC694.`);
    return { record: parsed.data.records[0], store };
  }
  async capture(providers) {
    const next = structuredClone(providers);
    const records = [];
    const status = [];
    const registryFile = await readKnown2(path6.join(this.home, "paseo-accounts", "accounts.json"));
    const registry = registryFile ? parseObject(registryFile.raw, "Paseo \uACC4\uC815 \uBAA9\uB85D") : null;
    if (registry && !Array.isArray(registry.accounts)) throw new Error("Paseo \uACC4\uC815 \uBAA9\uB85D \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    for (const profile of this.profiles(providers)) {
      const tokenNames = profile.vendor === "claude" ? CLAUDE_AUTH_ENV : ["OPENAI_API_KEY", "CODEX_API_KEY"];
      if (tokenNames.some((name) => profile.env[name])) {
        for (const id of profile.providerIds) {
          const entry = object3(next[id]) ? next[id] : {};
          next[id] = { ...entry, env: { ...object3(entry.env) ? entry.env : {}, ...Object.fromEntries(tokenNames.filter((name) => profile.env[name]).map((name) => [name, profile.env[name]])) } };
        }
        status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: "environment", store: "environment" });
        continue;
      }
      const captured = await this.record(profile);
      if (captured.record) {
        const accounts = [];
        for (const entry of registry?.accounts ?? []) {
          if (!object3(entry) || entry.base !== profile.vendor || typeof entry.id !== "string" || typeof entry.signedIn !== "boolean") continue;
          const accountHome = entry.home === null ? path6.join(this.userHome, profile.vendor === "claude" ? ".claude" : ".codex") : typeof entry.home === "string" ? expand2(entry.home, "", this.userHome) : null;
          if (accountHome !== profile.directory) continue;
          accounts.push({ id: entry.id, base: profile.vendor, ...typeof entry.name === "string" ? { name: entry.name } : {}, home: null, email: typeof entry.email === "string" ? entry.email : null, identity: typeof entry.identity === "string" ? entry.identity : null, signedIn: entry.signedIn });
        }
        if (accounts.length) captured.record.metadata.accounts = accounts;
        records.push(captured.record);
        for (const id of profile.providerIds) {
          const entry = object3(next[id]) ? next[id] : {};
          next[id] = { ...entry, env: { ...object3(entry.env) ? entry.env : {}, ...profile.vendor === "claude" ? { CLAUDE_CONFIG_DIR: profile.configDirectory, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile.directory, ...Object.fromEntries(CLAUDE_AUTH_ENV.map((name) => [name, ""])) } : { CODEX_HOME: profile.directory } } };
        }
      }
      status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: captured.record ? "available" : "missing", store: captured.store });
    }
    const vendors = await captureVendorCredentials(this.vendorOptions(), next);
    return { providers: vendors.providers, credentials: providerCredentialsSchema.parse({ version: 1, records: [...records, ...vendors.records] }), status: [...status, ...vendors.status] };
  }
  async restore(providers, input, currentProviders = providers, options = {}) {
    const parsed = providerCredentialsSchema.safeParse(input);
    if (!parsed.success) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uBC31\uC5C5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    let next = structuredClone(providers);
    const undo = [];
    const auditId = randomUUID4();
    const auditPrefix = `[settings-sync] Claude authentication restore ${auditId} pid=${process.pid}`;
    let wroteClaude = false;
    const locks = /* @__PURE__ */ new Map();
    const borrowedLocks = new Set();
    const releaseLocks = async () => {
      for (const [directory, lock] of locks) if (!borrowedLocks.has(directory) && this.preparedClaudeLocks.get(directory) === lock) this.preparedClaudeLocks.delete(directory);
      const results = await Promise.allSettled([...locks.entries()].filter(([directory]) => !borrowedLocks.has(directory)).map(([, lock]) => lock.release()));
      if (results.some((result) => result.status === "rejected")) throw new Error("Claude \uC778\uC99D \uC800\uC7A5 \uC7A0\uAE08 \uD574\uC81C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
      for (const lock of locks.values()) lock.check();
      locks.clear();
    };
    const checkLocks = async () => {
      for (const lock of new Set([...this.preparedClaudeLocks.values(), ...locks.values()])) await lock.verify();
    };
    let committed = false;
    let finished = false;
    const rollback = async () => {
      if (finished) return;
      const failures = [];
      for (const action of [...undo].reverse()) {
        try {
          await checkLocks();
          await action();
        } catch {
          failures.push(true);
        }
      }
      await releaseLocks();
      if (wroteClaude) console.info(`${auditPrefix}: ${failures.length ? "rollback failed" : "rolled back"}`);
      if (failures.length) throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uBCF5\uAD6C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uAE30\uAE30\uC758 \uD504\uB85C\uBC14\uC774\uB354 \uB85C\uADF8\uC778\uC744 \uD655\uC778\uD558\uC138\uC694.");
      finished = true;
      undo.length = 0;
    };
    const write = async (file, raw, stamp, expected) => {
      await checkLocks();
      const previous = await readKnown2(file);
      if (expected !== void 0 && (previous?.raw ?? null) !== expected) throw concurrentAuthentication();
      let applied = false;
      undo.push(async () => {
        if (!applied) return;
        const current = await readKnown2(file);
        if (current?.raw !== raw) throw new Error("\uC778\uC99D \uC801\uC6A9 \uC774\uD6C4 \uD30C\uC77C\uC774 \uBCC0\uACBD\uB418\uC5B4 \uC790\uB3D9 \uBCF5\uAD6C\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
        if (previous) {
          await writeFile2(file, previous.raw, { mode: 384 });
          await utimes3(file, previous.updatedAt / 1e3, previous.updatedAt / 1e3);
        } else await rm3(file, { force: true });
      });
      const temporary = `${file}.${randomUUID4()}.tmp`;
      try {
        await writeFile2(temporary, raw, { mode: 384, flag: "wx" });
        if (((await readKnown2(file))?.raw ?? null) !== (previous?.raw ?? null)) throw concurrentAuthentication();
        await checkLocks();
        await rename3(temporary, file);
        applied = true;
        await utimes3(file, stamp / 1e3, stamp / 1e3);
      } finally {
        await rm3(temporary, { force: true });
      }
    };
    try {
      for (const incoming of parsed.data.records) {
        if (incoming.vendor !== "claude" && incoming.vendor !== "codex") continue;
        if (incoming.vendor === "codex" && ([this.env.OPENAI_API_KEY, this.env.CODEX_API_KEY].some(Boolean) || incoming.providerIds.some((id) => {
          const env = this.effectiveEnvironment(id, next);
          return !!(env.OPENAI_API_KEY || env.CODEX_API_KEY);
        }))) throw new Error("\uD604\uC7AC Paseo \uB610\uB294 \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC758 Codex API \uD0A4\uAC00 \uAC00\uC838\uC62C \uACC4\uC815\uC744 \uAC00\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4. OPENAI_API_KEY\uC640 CODEX_API_KEY\uB97C \uD574\uC81C\uD55C \uB4A4 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD558\uC138\uC694.");
        let profile = this.profiles(currentProviders).find((candidate) => candidate.vendor === incoming.vendor && candidate.providerIds.some((id) => incoming.providerIds.includes(id)));
        let local = profile ? await this.record(profile) : { record: null, store: "none" };
        if (options.preserveLocalClaude && incoming.vendor === "claude" && profile && !canRenewClaudeCredential(local.record, incoming)) {
          const activeEnvironment = profile.env;
          const configFile = !local.record ? await readKnown2(path6.join(profile.configDirectory, ".claude.json")) : null;
          const account = configFile ? parseObject(configFile.raw, "Claude \uACC4\uC815 \uC124\uC815").oauthAccount : null;
          const initialized = object3(account) && typeof account.accountUuid === "string" && !!account.accountUuid;
          if (local.record || initialized || CLAUDE_AUTH_ENV.some((name) => activeEnvironment[name])) {
            for (const id of incoming.providerIds) {
              const entry = object3(next[id]) ? next[id] : {};
              const env = { ...object3(entry.env) ? entry.env : {} };
              const previous = asProviders(currentProviders)[id];
              const previousEnv = object3(previous?.env) ? previous.env : {};
              for (const name of [...CLAUDE_AUTH_ENV, "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"]) {
                delete env[name];
                if (previousEnv[name] !== void 0) env[name] = previousEnv[name];
              }
              if (!previous && !profile.defaultProfile) Object.assign(env, { CLAUDE_CONFIG_DIR: profile.configDirectory, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile.directory });
              if (local.store === "windows-credman") env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
              next[id] = { ...entry, env };
            }
            continue;
          }
        }
        const keepProfile = !!local.record && local.record.identity === incoming.identity;
        if (!local.record || local.record.identity !== incoming.identity) {
          const directory2 = await managedDirectory(this.home, incoming.id);
          profile = { vendor: incoming.vendor, providerIds: incoming.providerIds, directory: directory2, configDirectory: directory2, defaultProfile: false, secureService: incoming.vendor === "claude" && this.platform === "win32" ? claudeCredentialService(directory2, false) : null, env: this.platform === "win32" && incoming.vendor === "claude" ? { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } : {} };
          local = await this.record(profile);
        }
        const { directory, configDirectory } = profile;
        const chosen = local.record && local.record.identity === incoming.identity ? newerCredential(local.record, incoming) : incoming;
        const raw = JSON.stringify(chosen.credential);
        const { accounts: _accounts, ...chosenMetadata } = chosen.metadata;
        const unchanged = local.record && JSON.stringify(local.record.credential) === raw && JSON.stringify(local.record.metadata) === JSON.stringify(chosenMetadata);
        if (incoming.vendor === "claude" && !unchanged && !locks.has(directory)) {
          const prepared = this.preparedClaudeLocks.get(directory);
          if (prepared) borrowedLocks.add(directory);
          locks.set(directory, prepared ?? await lockClaudeAuthentication(directory));
          if (!wroteClaude) console.info(`${auditPrefix}: locked and preparing`);
          wroteClaude = true;
        }
        await checkLocks();
        const credentialFile = path6.join(directory, incoming.vendor === "claude" ? ".credentials.json" : "auth.json");
        const observedFile = !unchanged ? await readKnown2(credentialFile) : null;
        const service = profile.secureService;
        const observedSecure = !unchanged && service && this.secure ? await readSecure(this.secure, service) : null;
        const latest = await this.record(profile, locks.has(directory));
        if (latest.record?.identity !== local.record?.identity || JSON.stringify(latest.record?.credential) !== JSON.stringify(local.record?.credential)) throw concurrentAuthentication();
        if (incoming.vendor === "claude") await options.beforeClaudeWrite?.(incoming);
        if (!unchanged && incoming.vendor === "claude") {
          console.info(`${auditPrefix}: providers=${incoming.providerIds.join(",")} localExpiresAt=${local.record?.expiresAt ?? "none"} incomingExpiresAt=${incoming.expiresAt ?? "none"} chosenExpiresAt=${chosen.expiresAt ?? "none"}`);
          if (this.platform === "darwin") throw new Error("macOS Claude \uD0A4\uCCB4\uC778 \uAC00\uC838\uC624\uAE30\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uD504\uB85C\uBC14\uC774\uB354 \uD658\uACBD\uC5D0 CLI \uC7A5\uAE30 \uC2E4\uD589 \uD1A0\uD070\uC744 \uC9C0\uC815\uD558\uC138\uC694.");
          const previousConfig = await readKnown2(path6.join(configDirectory, ".claude.json"));
          const existingConfig = previousConfig ? parseObject(previousConfig.raw, "Claude \uACC4\uC815 \uC124\uC815") : {};
          const config = { ...existingConfig, ...chosenMetadata, ...this.platform === "win32" ? { cachedGrowthBookFeatures: { ...object3(existingConfig.cachedGrowthBookFeatures) ? existingConfig.cachedGrowthBookFeatures : {}, tengu_windows_credman: true } } : {} };
          await write(path6.join(configDirectory, ".claude.json"), JSON.stringify(config), chosen.updatedAt, previousConfig?.raw ?? null);
          if (this.platform === "win32") {
            if (!this.secure) throw new Error("Windows Claude \uC778\uC99D \uC800\uC7A5\uC18C \uC5B4\uB311\uD130\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
            const previous2 = await readSecure(this.secure, service);
            if (authState("claude", previous2?.value ?? null) !== authState("claude", observedSecure?.value ?? null)) throw concurrentAuthentication();
            const originalCredential = previous2 ? parseObject(previous2.value, "Claude Windows") : {};
            const securedRaw = JSON.stringify({ ...originalCredential, ...chosen.credential });
            let applied = false;
            let started = false;
            const secureWrite = (value, expected, beforeMutation) => this.journal ? this.journal.write({ directory, service }, this.journalIO(profile, locks.get(directory)), value, expected, beforeMutation) : writeSecure(this.secure, service, value, expected, beforeMutation, checkLocks);
            undo.push(async () => {
              if (!started) return;
              if (applied && (await readSecure(this.secure, service))?.value !== securedRaw) throw new Error("\uC778\uC99D \uC801\uC6A9 \uC774\uD6C4 Windows \uC790\uACA9\uC99D\uBA85\uC774 \uBCC0\uACBD\uB418\uC5B4 \uC790\uB3D9 \uBCF5\uAD6C\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
              await secureWrite(previous2?.value ?? null);
            });
            await secureWrite(securedRaw, previous2?.value ?? null, () => {
              started = true;
            });
            applied = true;
          }
          const file = credentialFile;
          const previous = await readKnown2(file);
          if (authState("claude", previous?.raw ?? null) !== authState("claude", observedFile?.raw ?? null)) throw concurrentAuthentication();
          await write(file, JSON.stringify({ ...previous ? parseObject(previous.raw, "Claude") : {}, ...chosen.credential }), chosen.updatedAt, previous?.raw ?? null);
        } else if (!unchanged) {
          const file = credentialFile;
          const previous = await readKnown2(file);
          if (authState("codex", previous?.raw ?? null) !== authState("codex", observedFile?.raw ?? null)) throw concurrentAuthentication();
          const originalCredential = previous ? parseObject(previous.raw, "Codex") : {};
          for (const name of ["OPENAI_API_KEY", "auth_mode", "tokens", "last_refresh", "agent_identity", "personal_access_token", "bedrock_api_key", "bedrock_access_keys"]) delete originalCredential[name];
          await write(file, JSON.stringify({ ...originalCredential, ...chosen.credential }), chosen.updatedAt, previous?.raw ?? null);
        }
        for (const id of incoming.providerIds) {
          const entry = object3(next[id]) ? next[id] : {};
          const env = { ...object3(entry.env) ? entry.env : {} };
          const names2 = incoming.vendor === "claude" ? ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] : ["CODEX_HOME"];
          for (const name of names2) delete env[name];
          const binding = keepProfile ? Object.fromEntries(names2.filter((name) => profile.env[name] !== void 0).map((name) => [name, profile.env[name]])) : incoming.vendor === "claude" ? { CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory } : { CODEX_HOME: directory };
          next[id] = { ...entry, env: { ...env, ...binding, ...incoming.vendor === "claude" ? Object.fromEntries(CLAUDE_AUTH_ENV.map((name) => [name, ""])) : {} } };
        }
        if (incoming.metadata.accounts?.length) {
          const registryDirectory = path6.join(this.home, "paseo-accounts");
          await mkdir4(registryDirectory, { recursive: true, mode: 448 });
          if ((await lstat4(registryDirectory)).isSymbolicLink()) throw new Error("Paseo \uACC4\uC815 \uBAA9\uB85D\uC5D0 \uC2EC\uBCFC\uB9AD \uB9C1\uD06C \uB514\uB809\uD130\uB9AC\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          const file = path6.join(registryDirectory, "accounts.json");
          const previous = await readKnown2(file);
          await options.beforeClaudeRegistryWrite?.(incoming, previous?.raw ?? null);
          const registry = previous ? parseObject(previous.raw, "Paseo \uACC4\uC815 \uBAA9\uB85D") : { accounts: [] };
          if (!Array.isArray(registry.accounts)) throw new Error("Paseo \uACC4\uC815 \uBAA9\uB85D \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          const ids = new Set(incoming.metadata.accounts.map((entry) => entry.id));
          const restoredAccounts = incoming.metadata.accounts.map((entry) => ({ ...entry, home: directory }));
          const replaced = registry.accounts.filter((entry) => object3(entry) && typeof entry.id === "string" && ids.has(entry.id) && JSON.stringify(entry) !== JSON.stringify(restoredAccounts.find((account) => account.id === entry.id)));
          const archive = Array.isArray(registry.settingsSyncPreviousAccounts) ? [...registry.settingsSyncPreviousAccounts] : [];
          for (const entry of replaced) if (!archive.some((saved) => object3(saved) && JSON.stringify(saved.account) === JSON.stringify(entry))) archive.push({ replacedAt: (/* @__PURE__ */ new Date()).toISOString(), account: entry });
          const accounts = [...registry.accounts.filter((entry) => !object3(entry) || typeof entry.id !== "string" || !ids.has(entry.id)), ...restoredAccounts];
          await write(file, JSON.stringify({ ...registry, accounts, ...archive.length ? { settingsSyncPreviousAccounts: archive } : {} }), incoming.updatedAt, previous?.raw ?? null);
          if (!keepProfile && incoming.vendor === "claude") {
            const shared = path6.join(this.userHome, ".claude", "projects");
            await mkdir4(shared, { recursive: true, mode: 448 });
            const projects = path6.join(directory, "projects");
            const link = await lstat4(projects).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (link) {
              if (await realpath3(projects) !== await realpath3(shared)) throw new Error("\uBCF5\uC6D0\uD560 Claude \uD504\uB85C\uD544\uC758 \uB300\uD654 \uAE30\uB85D \uACBD\uB85C\uAC00 \uC774\uBBF8 \uB2E4\uB978 \uB514\uB809\uD130\uB9AC\uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4.");
            } else {
              await symlink(shared, projects, this.platform === "win32" ? "junction" : "dir");
              undo.push(async () => {
                await rm3(projects, { force: true });
              });
            }
          }
        }
      }
      const vendors = await prepareVendorCredentialRestore(this.vendorOptions(), next, parsed.data.records.filter((record2) => record2.vendor !== "claude" && record2.vendor !== "codex"), currentProviders);
      next = vendors.providers;
      undo.push(vendors.rollback);
      for (const [directory, lock] of locks) this.preparedClaudeLocks.set(directory, lock);
      return { providers: next, get committed() { return committed; }, rollback, commit: async () => {
        await checkLocks();
        await vendors.commit();
        committed = true;
        finished = true;
        undo.length = 0;
        await releaseLocks();
        if (wroteClaude) console.info(`${auditPrefix}: committed`);
      } };
    } catch (error) {
      try {
        await rollback();
      } catch {
        throw new Error("\uD504\uB85C\uBC14\uC774\uB354 \uC778\uC99D \uC801\uC6A9 \uBC0F \uBCF5\uAD6C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 CLI\uC758 \uB85C\uADF8\uC778 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.");
      }
      throw error;
    }
  }
};

// <stdin>
var parseBundle = (value) => providerCredentialsSchema.parse(value);
var credentialRuntimeVersion = 3;
async function withCredentialLocks(storage, providers, directories, run) {
  const held = /* @__PURE__ */ new Map();
  try {
    for (const directory of [...new Set(directories)].sort()) {
      if (storage.preparedClaudeLocks.has(directory)) throw Error("Aster: credential operation already active");
      const profiles2 = storage.profiles(providers).filter((profile) => profile.vendor === "claude" && profile.directory === directory);
      for (const profile of profiles2) if (storage.journal && profile.secureService) await storage.journal.beforeLock({ directory, service: profile.secureService });
      const lock = await lockClaudeAuthentication(directory);
      held.set(directory, lock);
      await lock.verify();
      for (const profile of profiles2) if (storage.journal && profile.secureService) await storage.journal.recover({ directory, service: profile.secureService }, storage.journalIO(profile, lock));
      await lock.verify();
      storage.preparedClaudeLocks.set(directory, lock);
    }
    return await run();
  } finally {
    for (const [directory, lock] of held) if (storage.preparedClaudeLocks.get(directory) === lock) storage.preparedClaudeLocks.delete(directory);
    const results = await Promise.allSettled([...held.values()].map((lock) => lock.release()));
    if (results.some((result) => result.status === "rejected")) throw Error("Aster: credential lock cleanup failed");
    for (const lock of held.values()) lock.check();
  }
}
export {
  ProviderCredentialSync,
  credentialRuntimeVersion,
  parseBundle,
  withCredentialLocks
};
