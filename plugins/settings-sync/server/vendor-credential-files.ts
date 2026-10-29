import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { newerCredential, providerCredentialsSchema, type ProviderCredentialRecord } from "../shared/provider-credentials";
import { asProviders, providerFamily, type ProviderMap } from "../shared/provider-paths";

type Vendor = "cursor" | "pi" | "opencode";
type JsonObject = ProviderCredentialRecord["credential"];
export type VendorCredentialFileOptions = { home: string; userHome?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv };
export type VendorCredentialFileStatus = { vendor: Vendor; providerIds: string[]; status: "available" | "missing" | "environment" | "unsupported"; store: "file" | "environment" | "none" | "keychain" | "database" | "memory"; reason?: string };
type Context = Required<VendorCredentialFileOptions>;
type Profile = { vendor: Vendor; providerIds: string[]; file: string; env: NodeJS.ProcessEnv };
type FileValue = { raw: string; updatedAt: number };
const LIMIT = 1_048_576;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const token = z.string().max(262_144);
const nonempty = token.min(1);
const stringMap = z.record(z.string().max(200), token);
const oauth = { type: z.literal("oauth"), access: nonempty, refresh: token, expires: z.number().finite().nonnegative() };
const cursorSchema = z.object({
  accessToken: token.optional(), refreshToken: token.optional(), apiKey: token.optional(),
  bedrockCredentials: z.object({ accessKey: nonempty, secretKey: nonempty, sessionToken: token.optional() }).strict().optional(),
}).strict().refine((value) => !!(value.accessToken || value.apiKey || value.bedrockCredentials));
const piSchema = z.record(z.string().min(1).max(300), z.union([
  z.object({ type: z.literal("api_key"), key: token.optional(), env: stringMap.optional() }).strict().refine((value) => !!value.key || !!Object.keys(value.env ?? {}).length).refine((value) => !value.key?.startsWith("!")),
  z.object({ ...oauth, accountId: token.optional(), enterpriseUrl: token.optional(), clientId: token.optional(), scope: token.optional(), availableModelIds: z.array(z.string().max(300)).max(2000).optional() }).strict(),
]));
const opencodeSchema = z.record(z.string().min(1).max(2000), z.union([
  z.object({ ...oauth, accountId: token.optional(), enterpriseUrl: token.optional() }).strict(),
  z.object({ type: z.literal("api"), key: nonempty, metadata: stringMap.optional() }).strict(),
  z.object({ type: z.literal("wellknown"), key: nonempty, token: nonempty }).strict(),
]));
export const vendorCredentialFileFormats = {
  cursor: { basename: "auth.json", mime: "application/json" },
  pi: { basename: "auth.json", mime: "application/json" },
  opencode: { basename: "auth.json", mime: "application/json", version: 1 },
} as const;

function context(options: VendorCredentialFileOptions): Context {
  return { home: path.resolve(options.home), userHome: options.userHome ?? homedir(), platform: options.platform ?? process.platform, env: options.env ?? process.env };
}

function expand(value: string | undefined, fallback: string, userHome: string) {
  const raw = value || fallback;
  if (raw.startsWith("@paseo-") || /[\u0000\r\n]/.test(raw)) throw new Error("프로바이더 인증 프로필 경로를 현재 기기의 경로로 먼저 변환하세요.");
  return path.resolve(raw === "~" ? userHome : /^~[\\/]/.test(raw) ? path.join(userHome, raw.slice(2)) : raw);
}

export function vendorCredentialFilePath(vendor: Vendor, options: VendorCredentialFileOptions, env: NodeJS.ProcessEnv = options.env ?? process.env) {
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

function effectiveEnvironment(id: string, providers: ProviderMap, base: NodeJS.ProcessEnv, visited = new Set<string>()): NodeJS.ProcessEnv {
  if (visited.has(id)) throw new Error("프로바이더 상속 설정에 순환이 있습니다.");
  visited.add(id);
  const entry = providers[id];
  const inherited = typeof entry?.extends === "string" && providers[entry.extends] ? effectiveEnvironment(entry.extends, providers, base, visited) : base;
  const own = object(entry?.env) ? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {};
  return { ...inherited, ...own };
}

function family(id: string, providers: ProviderMap): Vendor | null {
  const detected = providerFamily(id, providers);
  if (detected === "cursor" || detected === "pi" || detected === "opencode") return detected;
  const command = providers[id]?.command;
  if (providers[id]?.extends === "acp" && Array.isArray(command) && typeof command[0] === "string" && /^cursor-agent(?:\.(?:cmd|exe|bat|ps1))?$/i.test(command[0].replaceAll("\\", "/").split("/").at(-1)!)) return "cursor";
  return null;
}

function profiles(options: Context, value: Record<string, unknown>, enabledOnly = true): Profile[] {
  const providers = asProviders(value);
  const result = new Map<string, Profile>();
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

async function safeParents(file: string) {
  let current = path.dirname(path.resolve(file));
  while (true) {
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("프로바이더 인증 경로에 심볼릭 링크나 잘못된 디렉터리를 사용할 수 없습니다."); }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readKnown(file: string): Promise<FileValue | null> {
  try {
    await safeParents(file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw new Error();
    const raw = await readFile(file, "utf8");
    if (Buffer.byteLength(raw) > LIMIT) throw new Error();
    return { raw, updatedAt: Math.max(0, Math.trunc(stat.mtimeMs)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("프로바이더 인증 파일을 안전하게 읽을 수 없습니다. 권한과 심볼릭 링크를 확인하세요.");
  }
}

function parse(vendor: Vendor, value: unknown): JsonObject {
  const parsed = (vendor === "cursor" ? cursorSchema : vendor === "pi" ? piSchema : opencodeSchema).safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > LIMIT) throw new Error(`${vendor} 인증 파일 형식을 지원하지 않습니다. 해당 CLI에서 다시 로그인하거나 프로바이더 환경에 API 키를 지정하세요.`);
  return parsed.data as JsonObject;
}

function parseFile(vendor: Vendor, raw: string): JsonObject | null {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`${vendor} 인증 파일이 손상되었습니다. 해당 CLI에서 다시 로그인하세요.`); }
  if (!object(value)) return parse(vendor, value);
  if (!Object.keys(value).length) return null;
  if (vendor === "cursor") {
    const known = Object.fromEntries(["accessToken", "refreshToken", "apiKey", "bedrockCredentials"].filter((name) => value[name] !== undefined && value[name] !== null).map((name) => [name, value[name]]));
    if (!Object.keys(known).length) throw new Error("cursor 인증 파일 형식을 지원하지 않습니다. Cursor CLI에서 다시 로그인하세요.");
    return parse(vendor, known);
  }
  return parse(vendor, value);
}

function jwt(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try { const claims: unknown = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")); return object(claims) ? claims : {}; }
  catch { return {}; }
}

function identity(vendor: Vendor, credential: JsonObject) {
  if (vendor === "cursor") return hash([vendor, jwt(credential.accessToken).sub || credential.apiKey || credential.refreshToken || credential.accessToken || (object(credential.bedrockCredentials) ? credential.bedrockCredentials.accessKey : null)]);
  return hash([vendor, Object.entries(credential).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => {
    const entry = object(value) ? value : {};
    return [id, entry.type, entry.accountId || jwt(entry.access).sub || entry.refresh || (entry.type === "wellknown" ? entry.token : entry.key) || entry.access || entry.env];
  })]);
}

function expiresAt(vendor: Vendor, credential: JsonObject) {
  const expirations = vendor === "cursor" ? [Number(jwt(credential.accessToken).exp) * 1000] : Object.values(credential).map((entry) => object(entry) ? entry.expires : null);
  const finite = expirations.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return finite.length ? Math.min(...finite) : null;
}

function record(profile: Profile, source: FileValue, credential: JsonObject): ProviderCredentialRecord {
  const ids = [...profile.providerIds].sort();
  const primary = ids.includes(profile.vendor) ? profile.vendor : ids[0];
  return { id: `${profile.vendor}-${hash(primary).slice(0, 24)}`, vendor: profile.vendor, providerIds: ids, credential, metadata: {}, identity: identity(profile.vendor, credential), updatedAt: source.updatedAt, expiresAt: expiresAt(profile.vendor, credential) };
}

function fileEnvironment(profile: Profile, options: Context) {
  return profile.vendor === "cursor" ? { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "", APPDATA: path.dirname(path.dirname(profile.file)), XDG_CONFIG_HOME: path.dirname(path.dirname(profile.file)) }
    : profile.vendor === "pi" ? { PI_CODING_AGENT_DIR: path.dirname(profile.file) } : { XDG_DATA_HOME: path.dirname(path.dirname(profile.file)), OPENCODE_AUTH_CONTENT: "" };
}

function applyFileEnvironment(providers: Record<string, unknown>, profile: Profile, options: Context) {
  for (const id of profile.providerIds) {
    const entry = object(providers[id]) ? providers[id] : {};
    const env = object(entry.env) ? { ...entry.env } : {};
    const keys = profile.vendor === "cursor" ? ["APPDATA", "XDG_CONFIG_HOME", "AGENT_CLI_CREDENTIAL_STORE", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] : profile.vendor === "pi" ? ["PI_CODING_AGENT_DIR"] : ["XDG_DATA_HOME", "OPENCODE_AUTH_CONTENT"];
    for (const key of keys) delete env[key];
    providers[id] = { ...entry, env: { ...env, ...fileEnvironment(profile, options) } };
  }
}

async function unsupported(profile: Profile, options: Context): Promise<Pick<VendorCredentialFileStatus, "store" | "reason"> | null> {
  if (profile.vendor === "cursor") {
    if (profile.env.AGENT_CLI_CREDENTIAL_STORE === "memory") return { store: "memory", reason: "Cursor의 메모리 인증은 내보낼 수 없습니다. 프로바이더 환경에 API 키를 지정하세요." };
    if (options.platform === "darwin" && profile.env.AGENT_CLI_CREDENTIAL_STORE !== "file") return { store: "keychain", reason: "Cursor macOS 키체인 내보내기는 지원하지 않습니다. 프로바이더 환경에 API 키를 지정하세요." };
  }
  if (profile.vendor === "opencode") {
    try { await lstat(profile.env.OPENCODE_DB ? expand(profile.env.OPENCODE_DB, "", options.userHome) : path.join(path.dirname(profile.file), "opencode.db")); return { store: "database", reason: "OpenCode 2의 데이터베이스 인증은 파일 복사로 동기화할 수 없습니다. OpenCode에서 계정을 연결하거나 프로바이더 환경에 API 키를 지정하세요." }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("OpenCode 인증 저장소를 확인할 수 없습니다."); }
  }
  return null;
}

export async function captureVendorCredentials(options: VendorCredentialFileOptions, providers: Record<string, unknown>) {
  const ctx = context(options);
  const next = structuredClone(providers);
  const records: ProviderCredentialRecord[] = [];
  const status: VendorCredentialFileStatus[] = [];
  for (const profile of profiles(ctx, providers)) {
    const tokenNames = profile.vendor === "cursor" ? ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] : profile.vendor === "opencode" ? ["OPENCODE_AUTH_CONTENT"] : [];
    if (tokenNames.some((name) => profile.env[name])) {
      if (profile.vendor === "opencode") {
        parseFile("opencode", profile.env.OPENCODE_AUTH_CONTENT!);
      }
      for (const id of profile.providerIds) {
        const entry = object(next[id]) ? next[id] : {};
        next[id] = { ...entry, env: { ...(object(entry.env) ? entry.env : {}), ...Object.fromEntries(tokenNames.filter((name) => profile.env[name]).map((name) => [name, profile.env[name]])) } };
      }
      status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: "environment", store: "environment" });
      continue;
    }
    const blocked = await unsupported(profile, ctx);
    if (blocked) { status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: "unsupported", ...blocked }); continue; }
    const source = await readKnown(profile.file);
    const credential = source ? parseFile(profile.vendor, source.raw) : null;
    if (source && credential) { records.push(record(profile, source, credential)); applyFileEnvironment(next, profile, ctx); }
    status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: credential ? "available" : "missing", store: credential ? "file" : "none" });
  }
  return { providers: next, records: providerCredentialsSchema.parse({ version: 1, records }).records, status };
}

function managedProfile(options: Context, incoming: ProviderCredentialRecord): Profile {
  if (!/^(cursor|pi|opencode)-[a-f0-9]{24}$/.test(incoming.id)) throw new Error("잘못된 프로바이더 인증 프로필 ID입니다.");
  const root = path.join(options.home, "settings-sync", "provider-profiles", incoming.id);
  const env = incoming.vendor === "cursor" ? { AGENT_CLI_CREDENTIAL_STORE: "file", ...(options.platform === "win32" ? { APPDATA: path.join(root, "roaming") } : { XDG_CONFIG_HOME: path.join(root, "config") }) }
    : incoming.vendor === "pi" ? { PI_CODING_AGENT_DIR: root } : { XDG_DATA_HOME: path.join(root, "data") };
  return { vendor: incoming.vendor as Vendor, providerIds: incoming.providerIds, env, file: vendorCredentialFilePath(incoming.vendor as Vendor, options, env) };
}

export async function prepareVendorCredentialRestore(options: VendorCredentialFileOptions, providers: Record<string, unknown>, input: ProviderCredentialRecord[], currentProviders: Record<string, unknown> = providers) {
  const parsed = providerCredentialsSchema.safeParse({ version: 1, records: input });
  if (!parsed.success) throw new Error("프로바이더 인증 백업 형식이 올바르지 않습니다.");
  const ctx = context(options);
  const next = structuredClone(providers);
  const incomingProviders = asProviders(providers);
  const localProfiles = profiles(ctx, currentProviders, false);
  const undo: (() => Promise<void>)[] = [];
  let finished = false;
  const rollback = async () => {
    if (finished) return;
    let failed = false;
    for (const action of [...undo].reverse()) { try { await action(); } catch { failed = true; } }
    finished = true; undo.length = 0;
    if (failed) throw new Error("프로바이더 인증 복구에 실패했습니다. 해당 CLI의 로그인 상태를 확인하세요.");
  };
  try {
    for (const incoming of parsed.data.records) {
      if (!["cursor", "pi", "opencode"].includes(incoming.vendor)) throw new Error("파일 인증 어댑터가 지원하지 않는 프로바이더입니다.");
      const vendor = incoming.vendor as Vendor;
      const credential = parse(vendor, incoming.credential);
      if (incoming.providerIds.some((id) => family(id, incomingProviders) !== vendor)) throw new Error("인증 백업과 프로바이더 종류가 일치하지 않습니다.");
      if (incoming.identity !== identity(vendor, credential)) throw new Error("프로바이더 인증 계정 식별자가 올바르지 않습니다.");
      if (incoming.updatedAt > 8_640_000_000_000_000) throw new Error("프로바이더 인증 갱신 시점이 올바르지 않습니다.");
      let profile = localProfiles.find((candidate) => candidate.vendor === vendor && candidate.providerIds.some((id) => incoming.providerIds.includes(id)));
      let local: ProviderCredentialRecord | null = null;
      if (profile && !await unsupported(profile, ctx)) {
        const source = await readKnown(profile.file);
        const localCredential = source ? parseFile(vendor, source.raw) : null;
        if (source && localCredential) local = record(profile, source, localCredential);
      }
      if (!profile || !local || local.identity !== incoming.identity) {
        if (vendor === "cursor" && ctx.platform === "darwin") throw new Error("Cursor macOS 파일 인증은 기존의 같은 계정만 갱신할 수 있습니다. 이 기기의 Cursor에서 먼저 로그인하세요.");
        profile = managedProfile(ctx, incoming);
        const source = await readKnown(profile.file);
        const localCredential = source ? parseFile(vendor, source.raw) : null;
        local = source && localCredential ? record(profile, source, localCredential) : null;
      }
      const previous = await readKnown(profile.file);
      const latestCredential = previous ? parseFile(vendor, previous.raw) : null;
      const latest = previous && latestCredential ? record(profile, previous, latestCredential) : null;
      if ((latest?.identity ?? null) !== (local?.identity ?? null)) throw new Error("복원 중 프로바이더 계정이 변경되었습니다. 동기화를 다시 시도하세요.");
      const chosen = latest?.identity === incoming.identity ? newerCredential(latest, incoming) : incoming;
      const selected = parse(vendor, chosen.credential);
      const previousObject: Record<string, unknown> = vendor === "cursor" && previous ? JSON.parse(previous.raw) : {};
      for (const key of ["accessToken", "refreshToken", "apiKey", "bedrockCredentials"]) delete previousObject[key];
      const raw = JSON.stringify({ ...previousObject, ...selected });
      if (previous?.raw !== raw) {
        await safeParents(profile.file);
        await mkdir(path.dirname(profile.file), { recursive: true, mode: 0o700 });
        await safeParents(profile.file);
        const temporary = `${profile.file}.${randomUUID()}.tmp`;
        const undoWrite = async () => {
          const current = await readKnown(profile!.file);
          if (current?.raw !== raw) throw new Error("인증 복원 중 인증 정보가 변경되었습니다.");
          if (previous) { await writeFile(profile!.file, previous.raw, { mode: 0o600 }); await utimes(profile!.file, previous.updatedAt / 1000, previous.updatedAt / 1000); }
          else await rm(profile!.file, { force: true });
        };
        try {
          await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
          if (((await readKnown(profile.file))?.raw ?? null) !== (previous?.raw ?? null)) throw new Error("복원 준비 중 프로바이더 계정 또는 인증이 갱신되었습니다. 최신 인증을 보존했으니 다시 동기화하세요.");
          await rename(temporary, profile.file); undo.push(undoWrite); await utimes(profile.file, chosen.updatedAt / 1000, chosen.updatedAt / 1000);
        }
        finally { await rm(temporary, { force: true }); }
      }
      applyFileEnvironment(next, { ...profile, providerIds: incoming.providerIds }, ctx);
    }
  } catch (error) { await rollback(); throw error; }
  return { providers: next, rollback, commit: async () => { finished = true; undo.length = 0; } };
}
