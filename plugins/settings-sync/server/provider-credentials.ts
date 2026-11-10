import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canRenewClaudeCredential, newerCredential, normalizeVendorCredential, providerCredentialsSchema, type ProviderCredentialRecord, type ProviderCredentials } from "../shared/provider-credentials";
import { captureVendorCredentials, prepareVendorCredentialRestore, type VendorCredentialFileStatus } from "./vendor-credential-files";
import { asProviders, providerFamily } from "../shared/provider-paths";
import { lockClaudeAuthentication } from "./claude-auth-lock";
import { CHUNK, MAX_CHUNKS, NAME } from "./claude-secure-format";
import { ClaudeSecureJournal, type JournalIO, type JournalWriter } from "./claude-secure-journal";
import { sharedWindowsCredentialReader } from "./windows-credential-reader";

type Providers = Record<string, unknown>;
type JsonObject = ProviderCredentialRecord["credential"];
type Vendor = "claude" | "codex";
export type SecureCredentialValue = { value: string; updatedAt: number; persistence?: number };
export interface ProviderSecureStore {
  read(service: string, name: string): Promise<SecureCredentialValue | null>;
  write(service: string, name: string, value: string): Promise<void>;
  remove(service: string, name: string): Promise<void>;
}
export type ProviderSecretRunner = (executable: string, args: string[], input: string) => Promise<string>;
/** Answers a read with the text the one-shot helper prints, or rejects when it cannot. */
export type ProviderSecretReader = { read(target: string): Promise<string> };
export type ProviderCredentialOptions = { home: string; userHome?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; secure?: ProviderSecureStore; run?: ProviderSecretRunner; reader?: ProviderSecretReader; journal?: ClaudeSecureJournal };
export type ProviderCredentialStatus = { vendor: Vendor; providerIds: string[]; status: "available" | "missing" | "environment"; store: "file" | "windows-credman" | "environment" | "none" };
const LIMIT = 1_048_576;
const CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const concurrentAuthentication = () => new Error("복원 준비 중 계정 또는 인증이 다른 프로세스에서 바뀌었습니다. 최신 인증을 보존했으니 다시 동기화하세요.");
const authState = (vendor: Vendor, raw: string | null) => JSON.stringify(raw === null ? null : normalizeVendorCredential(vendor, parseObject(raw, vendor)));

function parseObject(raw: string, label: string): JsonObject {
  try {
    if (Buffer.byteLength(raw, "utf8") > LIMIT) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!object(value)) throw new Error();
    return value as JsonObject;
  } catch { throw new Error(`${label} 인증 데이터가 손상되었거나 지원하는 크기를 초과했습니다. 해당 CLI에서 다시 로그인하세요.`); }
}

async function readKnown(file: string): Promise<{ raw: string; updatedAt: number } | null> {
  try {
    let parent = path.dirname(path.resolve(file));
    while (true) {
      const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("unsafe");
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > LIMIT) throw new Error("unsafe");
    return { raw: await readFile(file, "utf8"), updatedAt: Math.max(0, Math.trunc(stat.mtimeMs)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("프로바이더 인증 파일을 안전하게 읽을 수 없습니다. 파일 권한과 심볼릭 링크를 확인하세요.");
  }
}

export function providerProfileDirectory(home: string, id: string): string {
  if (!/^(claude|codex|cursor|opencode|pi)-[a-f0-9]{24}$/.test(id)) throw new Error("잘못된 프로바이더 프로필 ID입니다.");
  return path.join(path.resolve(home), "settings-sync", "provider-profiles", id);
}

async function managedDirectory(home: string, id: string) {
  const directory = providerProfileDirectory(home, id);
  let current = path.resolve(home);
  for (const part of ["settings-sync", "provider-profiles", id]) {
    current = path.join(current, part);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("인증 프로필 경로에 심볼릭 링크를 사용할 수 없습니다.");
  }
  return directory;
}

function expand(value: string | undefined, fallback: string, userHome: string): string {
  const raw = value === undefined || value === "" ? fallback : value;
  if (raw.startsWith("@paseo-profile:")) throw new Error("프로바이더 프로필 경로를 먼저 현재 기기의 경로로 변환하세요.");
  return path.resolve(raw === "~" ? userHome : raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(userHome, raw.slice(2)) : raw);
}

function metadata(config: JsonObject): ProviderCredentialRecord["metadata"] {
  return {
    ...(object(config.oauthAccount) ? { oauthAccount: config.oauthAccount as JsonObject } : {}),
    ...(typeof config.hasCompletedOnboarding === "boolean" ? { hasCompletedOnboarding: config.hasCompletedOnboarding } : {}),
    ...(typeof config.lastOnboardingVersion === "string" ? { lastOnboardingVersion: config.lastOnboardingVersion } : {}),
  };
}

function jwtClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try { const parsed: unknown = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")); return object(parsed) ? parsed : {}; } catch { return {}; }
}

function identity(vendor: Vendor, credential: JsonObject, meta: ProviderCredentialRecord["metadata"]) {
  if (vendor === "claude") {
    const account = meta.oauthAccount ?? {};
    const oauth = object(credential.claudeAiOauth) ? credential.claudeAiOauth : {};
    const claims = jwtClaims(oauth.accessToken);
    const stable = account.accountUuid ?? account.accountId ?? claims.sub ?? account.emailAddress;
    return hash([vendor, stable ?? oauth.refreshToken ?? oauth.accessToken, account.organizationUuid ?? account.organizationId ?? null]);
  }
  const tokens = object(credential.tokens) ? credential.tokens : {};
  const claims = jwtClaims(tokens.id_token ?? tokens.access_token);
  if (credential.auth_mode === "apikey" || credential.auth_mode == null && typeof credential.OPENAI_API_KEY === "string" && credential.OPENAI_API_KEY) return hash([vendor, credential.OPENAI_API_KEY]);
  const provenance = object(tokens.oauth_provenance) ? tokens.oauth_provenance : {};
  return hash([vendor, tokens.account_id ?? claims.sub ?? credential.OPENAI_API_KEY ?? tokens.refresh_token ?? tokens.access_token, ...(tokens.login_owner_id != null || tokens.oauth_provenance != null ? [tokens.login_owner_id ?? null, provenance.issuer ?? null, provenance.client_id ?? null] : [])]);
}

function expiresAt(vendor: Vendor, credential: JsonObject) {
  if (vendor === "claude") {
    const oauth = credential.claudeAiOauth;
    return object(oauth) && typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
  }
  if (credential.auth_mode === "apikey" || credential.auth_mode == null && typeof credential.OPENAI_API_KEY === "string" && credential.OPENAI_API_KEY) return null;
  const tokens = object(credential.tokens) ? credential.tokens : {};
  const claims = jwtClaims(tokens.access_token);
  return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
}

export function claudeCredentialService(profile: string, defaultProfile: boolean) {
  return `Claude Code-credentials${defaultProfile ? "" : `-${hash(profile.normalize("NFC")).slice(0, 8)}`}`;
}

export const WINDOWS_CREDENTIAL_SCRIPT = String.raw`$ErrorActionPreference='Stop'
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

export const runProviderSecret: ProviderSecretRunner = (executable, args, input) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { windowsHide: true, stdio: "pipe" });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let finished = false;
  let failed = false;
  const abort = () => { if (finished || failed) return; failed = true; child.kill(); };
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true; clearTimeout(timer);
    if (ok) resolve(Buffer.concat(chunks).toString("utf8").trim());
    else reject(new Error("Windows 자격증명 저장소를 사용할 수 없습니다. 같은 Windows 사용자로 Paseo를 실행하고 자격증명 관리자 서비스를 확인하세요."));
  };
  const timer = setTimeout(abort, 20_000);
  child.stdout.on("data", (chunk: Buffer) => { if (failed) return; bytes += chunk.length; if (bytes > LIMIT * 2) abort(); else chunks.push(chunk); });
  child.stderr.resume();
  child.on("error", abort);
  child.on("close", (code) => finish(code === 0 && !failed));
  child.stdin.on("error", abort);
  child.stdin.end(input);
});

export class WindowsProviderSecureStore implements ProviderSecureStore {
  private writerTracker?: (service: string) => JournalWriter | undefined;
  setWriterTracker(tracker: (service: string) => JournalWriter | undefined) { this.writerTracker = tracker; }
  constructor(private run: ProviderSecretRunner = runProviderSecret, private systemRoot = process.env.SystemRoot ?? "C:\\Windows", private reader?: ProviderSecretReader) {}
  private async command(operation: "read" | "write" | "delete" | "normalize", service: string, name: string, value?: string) {
    const executable = path.win32.join(this.systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const writer = operation === "read" ? undefined : this.writerTracker?.(service);
    const oneShot = () => this.run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64")], JSON.stringify({ operation, target: `${service}/${name}`, ...(writer ? { writer } : {}), ...(value === undefined ? {} : { value: Buffer.from(value, "utf8").toString("base64") }) }));
    // Only reads use the resident helper, and whenever it cannot answer, the one-shot process decides.
    if (operation === "read" && this.reader) return this.reader.read(`${service}/${name}`).catch(oneShot);
    return oneShot();
  }
  async read(service: string, name: string): Promise<SecureCredentialValue | null> {
    const raw = await this.command("read", service, name);
    if (raw === "null") return null;
    try {
      const result: unknown = JSON.parse(raw);
      if (!object(result) || typeof result.value !== "string" || typeof result.updatedAt !== "number") throw new Error();
      return { value: Buffer.from(result.value, "base64").toString("utf8"), updatedAt: Math.max(0, result.updatedAt), ...(typeof result.persistence === "number" ? { persistence: result.persistence } : {}) };
    } catch { throw new Error("Windows 자격증명 저장소 응답을 읽을 수 없습니다."); }
  }
  async write(service: string, name: string, value: string) { await this.command("write", service, name, value); }
  // Call only while holding the CLI storage locks and retaining a complete fallback.
  async normalizePersistence(service: string, name: string, value: string) { await this.command("normalize", service, name, value); }
  async remove(service: string, name: string) { await this.command("delete", service, name); }
}

async function readSecure(store: ProviderSecureStore, service: string): Promise<SecureCredentialValue | null> {
  const meta = await store.read(service, `${NAME}#m`);
  if (!meta) return store.read(service, NAME);
  let info: { n: number; l: number };
  try { info = JSON.parse(meta.value); if (!Number.isInteger(info.n) || info.n < 1 || info.n > MAX_CHUNKS || !Number.isInteger(info.l) || info.l < 1 || info.l > info.n * CHUNK) throw new Error(); }
  catch { throw new Error("Claude Windows 인증 저장소의 분할 정보가 손상되었습니다. Claude CLI에서 다시 로그인하세요."); }
  const chunks = await Promise.all(Array.from({ length: info.n }, (_, index) => store.read(service, `${NAME}#${index}`)));
  const encoded = chunks.map((chunk) => chunk?.value ?? "").join("");
  if (chunks.some((chunk) => !chunk) || encoded.length !== info.l) throw new Error("Claude Windows 인증 저장소의 일부 데이터가 없습니다. Claude CLI에서 다시 로그인하세요.");
  return { value: Buffer.from(encoded, "base64").toString("utf8"), updatedAt: Math.max(meta.updatedAt, ...chunks.map((chunk) => chunk!.updatedAt)) };
}

async function writeSecure(store: ProviderSecureStore, service: string, raw: string | null, expected?: string | null, beforeMutation?: () => void, verify = async () => {}) {
  await verify();
  const previous = await store.read(service, `${NAME}#m`);
  let count = 0;
  if (previous) { try { const info = JSON.parse(previous.value); count = Number.isInteger(info.n) ? Math.min(MAX_CHUNKS, Math.max(0, info.n)) : 0; } catch { throw new Error("Claude Windows 인증 저장소가 손상되어 덮어쓸 수 없습니다."); } }
  const pending = await store.read(service, `${NAME}#p`);
  if (pending) {
    const unfinished = Number(pending.value);
    if (!Number.isInteger(unfinished) || unfinished < 0 || unfinished > MAX_CHUNKS) throw new Error("Claude Windows 인증 저장소의 진행 정보가 손상되었습니다.");
    count = Math.max(count, unfinished);
  }
  if (expected !== undefined && ((await readSecure(store, service))?.value ?? null) !== expected) throw concurrentAuthentication();
  beforeMutation?.();
  const mutate = async (action: () => Promise<void>) => { await verify(); await action(); await verify(); };
  if (raw !== null && Buffer.byteLength(raw, "utf8") > CHUNK) {
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    const next = Math.ceil(encoded.length / CHUNK);
    if (next > MAX_CHUNKS) throw new Error("Claude Windows 인증 데이터가 저장소 제한을 초과했습니다.");
    await mutate(() => store.write(service, `${NAME}#p`, String(Math.max(count, next))));
    for (let index = 0; index < next; index++) await mutate(() => store.write(service, `${NAME}#${index}`, encoded.slice(index * CHUNK, (index + 1) * CHUNK)));
    await mutate(() => store.write(service, `${NAME}#m`, JSON.stringify({ n: next, l: encoded.length })));
    await mutate(() => store.remove(service, NAME));
    for (let index = next; index < count; index++) await mutate(() => store.remove(service, `${NAME}#${index}`));
  } else {
    if (count) await mutate(() => store.write(service, `${NAME}#p`, String(count)));
    if (raw === null) await mutate(() => store.remove(service, NAME)); else await mutate(() => store.write(service, NAME, raw));
    await mutate(() => store.remove(service, `${NAME}#m`));
    for (let index = 0; index < count; index++) await mutate(() => store.remove(service, `${NAME}#${index}`));
  }
  await mutate(() => store.remove(service, `${NAME}#p`));
}

export class ProviderCredentialSync {
  private home: string;
  private userHome: string;
  private platform: NodeJS.Platform;
  private env: NodeJS.ProcessEnv;
  private secure?: ProviderSecureStore;
  private journal?: ClaudeSecureJournal;
  private preparedClaudeLocks = new Map<string, Awaited<ReturnType<typeof lockClaudeAuthentication>>>();
  constructor(options: ProviderCredentialOptions) {
    this.home = options.home; this.userHome = options.userHome ?? homedir(); this.platform = options.platform ?? process.platform; this.env = options.env ?? process.env;
    // An injected runner has to see every operation, so only the real Windows path gets the shared helper.
    const reader = () => options.reader ?? (process.platform === "win32" && !options.run ? sharedWindowsCredentialReader(this.env.SystemRoot) : undefined);
    this.secure = options.secure ?? (this.platform === "win32" ? new WindowsProviderSecureStore(options.run, this.env.SystemRoot, reader()) : undefined);
    this.journal = options.journal ?? (this.platform === "win32" && process.platform === "win32" && !options.secure && !options.run ? new ClaudeSecureJournal(path.join(this.home, "settings-sync", "claude-restore-journal")) : undefined);
    if (this.journal && this.secure instanceof WindowsProviderSecureStore) this.secure.setWriterTracker(service => this.journal!.writer(service));
  }
  private journalIO(profile: { configDirectory: string; directory: string; secureService: string | null }, lock: Awaited<ReturnType<typeof lockClaudeAuthentication>>): JournalIO {
    return {
      readEntry: async name => (await this.secure!.read(profile.secureService!, name))?.value ?? null,
      readComplete: async () => (await readSecure(this.secure!, profile.secureService!))?.value ?? null,
      writeComplete: (raw, beforeMutation) => writeSecure(this.secure!, profile.secureService!, raw, undefined, beforeMutation, lock.verify),
      context: async () => {
        const file = await readKnown(path.join(profile.configDirectory, ".claude.json"));
        const account = file ? parseObject(file.raw, "Claude 계정 설정").oauthAccount : null;
        return hash(object(account) ? [account.accountUuid ?? account.accountId ?? null, account.organizationUuid ?? account.organizationId ?? null, account.emailAddress ?? null] : null);
      },
      verify: lock.verify, locks: lock.snapshot,
    };
  }
  private vendorOptions() { return { home: this.home, userHome: this.userHome, platform: this.platform, env: this.env }; }
  private effectiveEnvironment(id: string, providers: Providers, visited = new Set<string>()): Record<string, string> {
    if (visited.has(id)) throw new Error("프로바이더 상속 설정에 순환이 있습니다.");
    visited.add(id);
    const entry = object(providers[id]) ? providers[id] : {};
    const base = typeof entry.extends === "string" ? this.effectiveEnvironment(entry.extends, providers, visited) : this.env;
    return Object.fromEntries(Object.entries({ ...base, ...(object(entry.env) ? entry.env : {}) }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  private profiles(providers: Providers) {
    const result = new Map<string, { vendor: Vendor; providerIds: string[]; directory: string; configDirectory: string; defaultProfile: boolean; secureService: string | null; env: Record<string, string> }>();
    for (const id of new Set(["claude", "codex", ...Object.keys(providers)])) {
      const vendor = providerFamily(id, asProviders(providers));
      if (vendor !== "claude" && vendor !== "codex") continue;
      const env = this.effectiveEnvironment(id, providers);
      const fallback = path.join(this.userHome, vendor === "claude" ? ".claude" : ".codex");
      const directory = expand(vendor === "claude" ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME, fallback, this.userHome);
      const configDirectory = vendor === "claude" ? expand(env.CLAUDE_CONFIG_DIR, this.userHome, this.userHome) : directory;
      const defaultProfile = vendor === "claude" && (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined ? !env.CLAUDE_SECURESTORAGE_CONFIG_DIR : !env.CLAUDE_CONFIG_DIR);
      // The CLI hashes the NFC-normalized environment spelling, before path resolution.
      const secureService = vendor === "claude" && this.platform === "win32" ? claudeCredentialService(env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? directory, defaultProfile) : null;
      const key = `${vendor}:${directory}:${secureService ?? ""}`;
      const previous = result.get(key);
      if (previous) previous.providerIds.push(id);
      else result.set(key, { vendor, providerIds: [id], directory, configDirectory, defaultProfile, secureService, env });
    }
    return [...result.values()];
  }
  private async record(profile: ReturnType<ProviderCredentialSync["profiles"]>[number], locked = false): Promise<{ record: ProviderCredentialRecord | null; store: ProviderCredentialStatus["store"] }> {
    if (profile.vendor !== "claude" || locked) return this.readRecord(profile);
    const prepared = this.preparedClaudeLocks.get(profile.directory);
    if (prepared) {
      await prepared.verify();
      const result = await this.readRecord(profile);
      await prepared.verify();
      return result;
    }
    const directory = await lstat(profile.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!directory) return this.readRecord(profile);
    if (this.journal && profile.secureService) await this.journal.beforeLock({ directory: profile.directory, service: profile.secureService });
    const lock = await lockClaudeAuthentication(profile.directory);
    try {
      await lock.verify();
      if (this.journal && profile.secureService) await this.journal.recover({ directory: profile.directory, service: profile.secureService }, this.journalIO(profile, lock));
      const result = await this.readRecord(profile);
      await lock.verify();
      return result;
    } finally { await lock.release(); }
  }
  private async readRecord(profile: ReturnType<ProviderCredentialSync["profiles"]>[number]): Promise<{ record: ProviderCredentialRecord | null; store: ProviderCredentialStatus["store"] }> {
    const { vendor, directory, configDirectory } = profile;
    const metaFile = vendor === "claude" ? await readKnown(path.join(configDirectory, ".claude.json")) : null;
    const config = metaFile ? parseObject(metaFile.raw, "Claude 계정 설정") : {};
    const meta = metadata(config);
    let source: { raw: string; updatedAt: number } | null = null;
    let store: ProviderCredentialStatus["store"] = "none";
    if (vendor === "claude" && this.platform === "win32") {
      const forced = profile.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === "1";
      const legacy = forced ? null : await readKnown(path.join(directory, ".config.json"));
      const backend = legacy?.raw ? parseObject(legacy.raw, "Claude 저장소 설정") : config;
      const enabled = forced || object(backend.cachedGrowthBookFeatures) && backend.cachedGrowthBookFeatures.tengu_windows_credman === true;
      if (enabled) {
        if (!this.secure) throw new Error("Windows Claude 인증 저장소 어댑터를 사용할 수 없습니다.");
        const secured = await readSecure(this.secure, profile.secureService!);
        if (secured) { source = { raw: secured.value, updatedAt: Math.trunc(secured.updatedAt) }; store = "windows-credman"; }
      }
    }
    if (!source) {
      source = await readKnown(path.join(directory, vendor === "claude" ? ".credentials.json" : "auth.json"));
      if (source) store = "file";
    }
    if (vendor === "claude" && this.platform === "win32" && store === "file" && source) {
      const file = parseObject(source.raw, "Claude");
      const oauth = file?.claudeAiOauth;
      const missing = oauth == null || object(oauth) && (oauth.accessToken == null || typeof oauth.accessToken === "string" && !oauth.accessToken.trim());
      if (missing && this.secure) {
        const secured = await readSecure(this.secure, profile.secureService!);
        if (secured) { source = { raw: secured.value, updatedAt: Math.trunc(secured.updatedAt) }; store = "windows-credman"; }
      }
    }
    if (!source) {
      if (vendor === "claude" && this.platform === "darwin" && config.oauthAccount) throw new Error("이 Claude 계정은 macOS 키체인에 저장되어 있습니다. 이 버전은 해당 키체인 내보내기를 지원하지 않습니다. CLI의 장기 실행 토큰을 프로바이더 환경에 지정하세요.");
      if (vendor === "codex") {
        const configuration = await readKnown(path.join(directory, "config.toml"));
        const global = configuration?.raw.split(/^\s*\[/m)[0] ?? "";
        if (/^\s*cli_auth_credentials_store\s*=\s*["']keyring["']\s*(?:#.*)?$/m.test(global)) throw new Error("Codex가 OS 키링 인증 저장소를 사용하고 있습니다. 이 버전은 Codex 키링 내보내기를 지원하지 않습니다. Codex의 cli_auth_credentials_store를 file로 설정한 뒤 CLI에서 다시 로그인하세요.");
      }
      return { record: null, store: "none" };
    }
    const credential = parseObject(source.raw, vendor);
    if (vendor === "claude") {
      const oauth = credential.claudeAiOauth;
      if (oauth == null) return { record: null, store };
      if (!object(oauth)) throw new Error("Claude OAuth 인증 데이터의 형식이 올바르지 않습니다. CLI에서 다시 로그인하세요.");
      if (oauth.accessToken == null || typeof oauth.accessToken === "string" && !oauth.accessToken.trim()) return { record: null, store };
      if (typeof oauth.accessToken !== "string") throw new Error("Claude OAuth 인증 토큰의 형식이 올바르지 않습니다. CLI에서 다시 로그인하세요.");
    }
    const ids = [...profile.providerIds].sort();
    const primary = ids.includes(vendor) ? vendor : ids[0];
    const id = `${vendor}-${hash(primary).slice(0, 24)}`;
    const expiry = expiresAt(vendor, credential);
    const updatedAt = vendor === "codex" && typeof credential.last_refresh === "string" && Number.isFinite(Date.parse(credential.last_refresh)) ? Date.parse(credential.last_refresh) : vendor === "claude" && expiry !== null ? expiry : source.updatedAt;
    const record = { id, vendor, providerIds: ids, credential, metadata: meta, identity: identity(vendor, credential, meta), updatedAt, expiresAt: expiry };
    const parsed = providerCredentialsSchema.safeParse({ version: 1, records: [record] });
    if (!parsed.success) throw new Error(`${vendor} 인증 형식을 지원하지 않습니다. CLI를 업데이트하거나 해당 프로바이더에서 다시 로그인하세요.`);
    return { record: parsed.data.records[0], store };
  }
  async capture(providers: Providers): Promise<{ providers: Providers; credentials: ProviderCredentials; status: (ProviderCredentialStatus | VendorCredentialFileStatus)[] }> {
    const next = structuredClone(providers);
    const records: ProviderCredentialRecord[] = [];
    const status: ProviderCredentialStatus[] = [];
    const registryFile = await readKnown(path.join(this.home, "paseo-accounts", "accounts.json"));
    const registry = registryFile ? parseObject(registryFile.raw, "Paseo 계정 목록") : null;
    if (registry && !Array.isArray(registry.accounts)) throw new Error("Paseo 계정 목록 형식이 올바르지 않습니다.");
    for (const profile of this.profiles(providers)) {
      const tokenNames = profile.vendor === "claude" ? CLAUDE_AUTH_ENV : ["OPENAI_API_KEY", "CODEX_API_KEY"];
      if (tokenNames.some((name) => profile.env[name])) {
        for (const id of profile.providerIds) {
          const entry = object(next[id]) ? next[id] : {};
          next[id] = { ...entry, env: { ...(object(entry.env) ? entry.env : {}), ...Object.fromEntries(tokenNames.filter((name) => profile.env[name]).map((name) => [name, profile.env[name]])) } };
        }
        status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: "environment", store: "environment" });
        continue;
      }
      const captured = await this.record(profile);
      if (captured.record) {
        const accounts: NonNullable<ProviderCredentialRecord["metadata"]["accounts"]> = [];
        for (const entry of registry?.accounts as unknown[] ?? []) {
          if (!object(entry) || entry.base !== profile.vendor || typeof entry.id !== "string" || typeof entry.signedIn !== "boolean") continue;
          const accountHome = entry.home === null ? path.join(this.userHome, profile.vendor === "claude" ? ".claude" : ".codex") : typeof entry.home === "string" ? expand(entry.home, "", this.userHome) : null;
          if (accountHome !== profile.directory) continue;
          accounts.push({ id: entry.id, base: profile.vendor, ...(typeof entry.name === "string" ? { name: entry.name } : {}), home: null, email: typeof entry.email === "string" ? entry.email : null, identity: typeof entry.identity === "string" ? entry.identity : null, signedIn: entry.signedIn });
        }
        if (accounts.length) captured.record.metadata.accounts = accounts;
        records.push(captured.record);
        for (const id of profile.providerIds) {
          const entry = object(next[id]) ? next[id] : {};
          next[id] = { ...entry, env: { ...(object(entry.env) ? entry.env : {}), ...(profile.vendor === "claude" ? { CLAUDE_CONFIG_DIR: profile.configDirectory, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile.directory, ...Object.fromEntries(CLAUDE_AUTH_ENV.map((name) => [name, ""])) } : { CODEX_HOME: profile.directory }) } };
        }
      }
      status.push({ vendor: profile.vendor, providerIds: profile.providerIds, status: captured.record ? "available" : "missing", store: captured.store });
    }
    const vendors = await captureVendorCredentials(this.vendorOptions(), next);
    return { providers: vendors.providers, credentials: providerCredentialsSchema.parse({ version: 1, records: [...records, ...vendors.records] }), status: [...status, ...vendors.status] };
  }
  async restore(providers: Providers, input: ProviderCredentials, currentProviders: Providers = providers, options: { preserveLocalClaude?: boolean } = {}) {
    const parsed = providerCredentialsSchema.safeParse(input);
    if (!parsed.success) throw new Error("프로바이더 인증 백업 형식이 올바르지 않습니다.");
    let next = structuredClone(providers);
    const undo: (() => Promise<void>)[] = [];
    const auditId = randomUUID();
    const auditPrefix = `[settings-sync] Claude authentication restore ${auditId} pid=${process.pid}`;
    let wroteClaude = false;
    const locks = new Map<string, Awaited<ReturnType<typeof lockClaudeAuthentication>>>();
    const releaseLocks = async () => {
      for (const [directory, lock] of locks) if (this.preparedClaudeLocks.get(directory) === lock) this.preparedClaudeLocks.delete(directory);
      const results = await Promise.allSettled([...locks.values()].map((lock) => lock.release()));
      if (results.some((result) => result.status === "rejected")) throw new Error("Claude 인증 저장 잠금 해제에 실패했습니다.");
      for (const lock of locks.values()) lock.check();
      locks.clear();
    };
    const checkLocks = async () => { for (const lock of locks.values()) await lock.verify(); };
    let finished = false;
    const rollback = async () => {
      if (finished) return;
      const failures = [];
      for (const action of [...undo].reverse()) { try { await checkLocks(); await action(); } catch { failures.push(true); } }
      await releaseLocks();
      if (wroteClaude) console.info(`${auditPrefix}: ${failures.length ? "rollback failed" : "rolled back"}`);
      if (failures.length) throw new Error("프로바이더 인증 복구에 실패했습니다. 현재 기기의 프로바이더 로그인을 확인하세요.");
      finished = true; undo.length = 0;
    };
    const write = async (file: string, raw: string, stamp: number, expected?: string | null) => {
      await checkLocks();
      const previous = await readKnown(file);
      if (expected !== undefined && (previous?.raw ?? null) !== expected) throw concurrentAuthentication();
      let applied = false;
      undo.push(async () => {
        if (!applied) return;
        const current = await readKnown(file);
        if (current?.raw !== raw) throw new Error("인증 적용 이후 파일이 변경되어 자동 복구하지 않았습니다.");
        if (previous) { await writeFile(file, previous.raw, { mode: 0o600 }); await utimes(file, previous.updatedAt / 1000, previous.updatedAt / 1000); } else await rm(file, { force: true });
      });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
        if (((await readKnown(file))?.raw ?? null) !== (previous?.raw ?? null)) throw concurrentAuthentication();
        await checkLocks();
        await rename(temporary, file); applied = true; await utimes(file, stamp / 1000, stamp / 1000);
      }
      finally { await rm(temporary, { force: true }); }
    };
    try {
      for (const incoming of parsed.data.records) {
        if (incoming.vendor !== "claude" && incoming.vendor !== "codex") continue;
        if (incoming.vendor === "codex" && ([this.env.OPENAI_API_KEY, this.env.CODEX_API_KEY].some(Boolean) || incoming.providerIds.some((id) => { const env = this.effectiveEnvironment(id, next); return !!(env.OPENAI_API_KEY || env.CODEX_API_KEY); }))) throw new Error("현재 Paseo 또는 프로바이더 환경의 Codex API 키가 가져올 계정을 가릴 수 있습니다. OPENAI_API_KEY와 CODEX_API_KEY를 해제한 뒤 다시 동기화하세요.");
        let profile = this.profiles(currentProviders).find((candidate) => candidate.vendor === incoming.vendor && candidate.providerIds.some((id) => incoming.providerIds.includes(id)));
        let local = profile ? await this.record(profile) : { record: null, store: "none" as const };
        if (options.preserveLocalClaude && incoming.vendor === "claude" && profile && !canRenewClaudeCredential(local.record, incoming)) {
          const activeEnvironment = profile.env;
          const configFile = !local.record ? await readKnown(path.join(profile.configDirectory, ".claude.json")) : null;
          const account = configFile ? parseObject(configFile.raw, "Claude 계정 설정").oauthAccount : null;
          const initialized = object(account) && typeof account.accountUuid === "string" && !!account.accountUuid;
          if (local.record || initialized || CLAUDE_AUTH_ENV.some((name) => activeEnvironment[name])) {
            for (const id of incoming.providerIds) {
              const entry = object(next[id]) ? next[id] : {};
              const env = { ...(object(entry.env) ? entry.env : {}) };
              const previous = asProviders(currentProviders)[id];
              const previousEnv = object(previous?.env) ? previous.env : {};
              for (const name of [...CLAUDE_AUTH_ENV, "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"]) {
                delete env[name];
                if (previousEnv[name] !== undefined) env[name] = previousEnv[name];
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
          const directory = await managedDirectory(this.home, incoming.id);
          profile = { vendor: incoming.vendor, providerIds: incoming.providerIds, directory, configDirectory: directory, defaultProfile: false, secureService: incoming.vendor === "claude" && this.platform === "win32" ? claudeCredentialService(directory, false) : null, env: (this.platform === "win32" && incoming.vendor === "claude" ? { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } : {}) as Record<string, string> };
          local = await this.record(profile);
        }
        const { directory, configDirectory } = profile!;
        const chosen = local.record && local.record.identity === incoming.identity ? newerCredential(local.record, incoming) : incoming;
        const raw = JSON.stringify(chosen.credential);
        const { accounts: _accounts, ...chosenMetadata } = chosen.metadata;
        const unchanged = local.record && JSON.stringify(local.record.credential) === raw && JSON.stringify(local.record.metadata) === JSON.stringify(chosenMetadata);
        if (incoming.vendor === "claude" && !unchanged && !locks.has(directory)) {
          locks.set(directory, await lockClaudeAuthentication(directory));
          if (!wroteClaude) console.info(`${auditPrefix}: locked and preparing`);
          wroteClaude = true;
        }
        await checkLocks();
        const credentialFile = path.join(directory, incoming.vendor === "claude" ? ".credentials.json" : "auth.json");
        const observedFile = !unchanged ? await readKnown(credentialFile) : null;
        const service = profile!.secureService;
        const observedSecure = !unchanged && service && this.secure ? await readSecure(this.secure, service) : null;
        const latest = await this.record(profile!, locks.has(directory));
        if (latest.record?.identity !== local.record?.identity || JSON.stringify(latest.record?.credential) !== JSON.stringify(local.record?.credential)) throw concurrentAuthentication();
        if (!unchanged && incoming.vendor === "claude") {
          console.info(`${auditPrefix}: providers=${incoming.providerIds.join(",")} localExpiresAt=${local.record?.expiresAt ?? "none"} incomingExpiresAt=${incoming.expiresAt ?? "none"} chosenExpiresAt=${chosen.expiresAt ?? "none"}`);
          if (this.platform === "darwin") throw new Error("macOS Claude 키체인 가져오기를 지원하지 않습니다. 프로바이더 환경에 CLI 장기 실행 토큰을 지정하세요.");
          const previousConfig = await readKnown(path.join(configDirectory, ".claude.json"));
          const existingConfig = previousConfig ? parseObject(previousConfig.raw, "Claude 계정 설정") : {};
          const config = { ...existingConfig, ...chosenMetadata, ...(this.platform === "win32" ? { cachedGrowthBookFeatures: { ...(object(existingConfig.cachedGrowthBookFeatures) ? existingConfig.cachedGrowthBookFeatures : {}), tengu_windows_credman: true } } : {}) };
          await write(path.join(configDirectory, ".claude.json"), JSON.stringify(config), chosen.updatedAt, previousConfig?.raw ?? null);
          if (this.platform === "win32") {
            if (!this.secure) throw new Error("Windows Claude 인증 저장소 어댑터를 사용할 수 없습니다.");
            const previous = await readSecure(this.secure, service!);
            if (authState("claude", previous?.value ?? null) !== authState("claude", observedSecure?.value ?? null)) throw concurrentAuthentication();
            const originalCredential = previous ? parseObject(previous.value, "Claude Windows") : {};
            const securedRaw = JSON.stringify({ ...originalCredential, ...chosen.credential });
            let applied = false;
            let started = false;
            const secureWrite = (value: string | null, expected?: string | null, beforeMutation?: () => void) => this.journal
              ? this.journal.write({ directory, service: service! }, this.journalIO(profile!, locks.get(directory)!), value, expected, beforeMutation)
              : writeSecure(this.secure!, service!, value, expected, beforeMutation, checkLocks);
            undo.push(async () => {
              if (!started) return;
              if (applied && (await readSecure(this.secure!, service!))?.value !== securedRaw) throw new Error("인증 적용 이후 Windows 자격증명이 변경되어 자동 복구하지 않았습니다.");
              await secureWrite(previous?.value ?? null);
            });
            await secureWrite(securedRaw, previous?.value ?? null, () => { started = true; }); applied = true;
          }
          const file = credentialFile;
          const previous = await readKnown(file);
          if (authState("claude", previous?.raw ?? null) !== authState("claude", observedFile?.raw ?? null)) throw concurrentAuthentication();
          await write(file, JSON.stringify({ ...(previous ? parseObject(previous.raw, "Claude") : {}), ...chosen.credential }), chosen.updatedAt, previous?.raw ?? null);
        } else if (!unchanged) {
          const file = credentialFile;
          const previous = await readKnown(file);
          if (authState("codex", previous?.raw ?? null) !== authState("codex", observedFile?.raw ?? null)) throw concurrentAuthentication();
          const originalCredential = previous ? parseObject(previous.raw, "Codex") : {};
          for (const name of ["OPENAI_API_KEY", "auth_mode", "tokens", "last_refresh", "agent_identity", "personal_access_token", "bedrock_api_key", "bedrock_access_keys"]) delete originalCredential[name];
          await write(file, JSON.stringify({ ...originalCredential, ...chosen.credential }), chosen.updatedAt, previous?.raw ?? null);
        }
        for (const id of incoming.providerIds) {
          const entry = object(next[id]) ? next[id] : {};
          const env = { ...(object(entry.env) ? entry.env : {}) };
          const names = incoming.vendor === "claude" ? ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] : ["CODEX_HOME"];
          for (const name of names) delete env[name];
          const binding = keepProfile ? Object.fromEntries(names.filter((name) => profile!.env[name] !== undefined).map((name) => [name, profile!.env[name]])) : incoming.vendor === "claude" ? { CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory } : { CODEX_HOME: directory };
          next[id] = { ...entry, env: { ...env, ...binding, ...(incoming.vendor === "claude" ? Object.fromEntries(CLAUDE_AUTH_ENV.map((name) => [name, ""])) : {}) } };
        }
        if (incoming.metadata.accounts?.length) {
          const registryDirectory = path.join(this.home, "paseo-accounts");
          await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
          if ((await lstat(registryDirectory)).isSymbolicLink()) throw new Error("Paseo 계정 목록에 심볼릭 링크 디렉터리를 사용할 수 없습니다.");
          const file = path.join(registryDirectory, "accounts.json");
          const previous = await readKnown(file);
          const registry = previous ? parseObject(previous.raw, "Paseo 계정 목록") : { accounts: [] };
          if (!Array.isArray(registry.accounts)) throw new Error("Paseo 계정 목록 형식이 올바르지 않습니다.");
          const ids = new Set(incoming.metadata.accounts.map((entry) => entry.id));
          const restoredAccounts = incoming.metadata.accounts.map((entry) => ({ ...entry, home: directory }));
          const replaced = registry.accounts.filter((entry) => object(entry) && typeof entry.id === "string" && ids.has(entry.id) && JSON.stringify(entry) !== JSON.stringify(restoredAccounts.find((account) => account.id === entry.id)));
          const archive = Array.isArray(registry.settingsSyncPreviousAccounts) ? [...registry.settingsSyncPreviousAccounts] : [];
          for (const entry of replaced) if (!archive.some((saved) => object(saved) && JSON.stringify(saved.account) === JSON.stringify(entry))) archive.push({ replacedAt: new Date().toISOString(), account: entry });
          const accounts = [...registry.accounts.filter((entry) => !object(entry) || typeof entry.id !== "string" || !ids.has(entry.id)), ...restoredAccounts];
          await write(file, JSON.stringify({ ...registry, accounts, ...(archive.length ? { settingsSyncPreviousAccounts: archive } : {}) }), incoming.updatedAt, previous?.raw ?? null);
          if (!keepProfile && incoming.vendor === "claude") {
            const shared = path.join(this.userHome, ".claude", "projects");
            await mkdir(shared, { recursive: true, mode: 0o700 });
            const projects = path.join(directory, "projects");
            const link = await lstat(projects).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
            if (link) { if (await realpath(projects) !== await realpath(shared)) throw new Error("복원할 Claude 프로필의 대화 기록 경로가 이미 다른 디렉터리를 사용합니다."); }
            else { await symlink(shared, projects, this.platform === "win32" ? "junction" : "dir"); undo.push(async () => { await rm(projects, { force: true }); }); }
          }
        }
      }
      const vendors = await prepareVendorCredentialRestore(this.vendorOptions(), next, parsed.data.records.filter((record) => record.vendor !== "claude" && record.vendor !== "codex"), currentProviders);
      next = vendors.providers;
      undo.push(vendors.rollback);
      for (const [directory, lock] of locks) this.preparedClaudeLocks.set(directory, lock);
      return { providers: next, rollback, commit: async () => { await checkLocks(); await vendors.commit(); finished = true; undo.length = 0; await releaseLocks(); if (wroteClaude) console.info(`${auditPrefix}: committed`); } };
    } catch (error) {
      try { await rollback(); } catch { throw new Error("프로바이더 인증 적용 및 복구에 실패했습니다. 해당 CLI의 로그인 상태를 확인하세요."); }
      throw error;
    }
  }
}
