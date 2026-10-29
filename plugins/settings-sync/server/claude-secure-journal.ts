import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CredentialStore, secretCommand, secretReferenceSchema } from "./credential-store";
import { decryptLocal, encryptLocal } from "./crypto";
import { CHUNK, MAX_CHUNKS, NAME } from "./claude-secure-format";
import type { ClaudeAuthLockEntry } from "./claude-auth-lock";
import { withClaudeRecoveryMutex } from "./claude-recovery-mutex";

type EntryMap = Record<string, string | null>;
export type JournalWriter = { file: string; nonce: string; owner: { pid: number; start: string } };
type Profile = { directory: string; service: string };
export type JournalIO = {
  readEntry(name: string): Promise<string | null>;
  readComplete(): Promise<string | null>;
  writeComplete(raw: string | null, beforeMutation?: () => void): Promise<void>;
  context(): Promise<string>;
  verify(): Promise<void>;
  locks(): ClaudeAuthLockEntry[];
};
const processSchema = z.object({ pid: z.number().int().positive(), start: z.string().min(1).max(200) }).strict();
const writerSchema = processSchema.extend({ nonce: z.string().uuid() }).strict();
const payloadSchema = z.object({
  version: z.literal(1), nonce: z.string().uuid(), directory: z.string(), service: z.string(), context: z.string(),
  owner: processSchema, locks: z.array(z.object({ file: z.string(), birthtime: z.number(), ino: z.number() }).strict()).length(3),
  count: z.number().int().min(0).max(MAX_CHUNKS), original: z.record(z.string(), z.string().nullable()),
  previous: z.string().max(1_048_576).nullable(), next: z.string().max(1_048_576).nullable(), goal: z.enum(["previous", "next"]),
}).strict();
const envelopeSchema = z.object({ version: z.literal(1), nonce: z.string().uuid(), key: secretReferenceSchema, ciphertext: z.string() }).strict();
type Payload = z.infer<typeof payloadSchema>;
type Loaded = { file: string; raw: string; envelope: z.infer<typeof envelopeSchema>; payload: Payload; password: string };
const changed = () => new Error("Claude 인증이 다른 작업에서 변경되어 자동 복구로 덮어쓰지 않았습니다.");
const activeWriter = () => new Error("이전 Claude 인증 저장 프로세스가 아직 실행 중입니다. 저장을 마친 뒤 다시 동기화하세요.");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function identifyProcess(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process identity");
  if (process.platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; $idValue=[int]([Console]::In.ReadToEnd()); try { $processValue=[Diagnostics.Process]::GetProcessById($idValue); [Console]::Out.Write($processValue.StartTime.ToUniversalTime().Ticks.ToString()); } catch [ArgumentException] { [Console]::Out.Write('absent'); }";
    const result = await secretCommand(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], String(pid));
    if (result === "absent") return null;
    if (!/^\d+$/.test(result)) throw new Error("Could not identify credential writer");
    return result;
  }
  if (process.platform === "linux") {
    try { const raw = await readFile(`/proc/${pid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  try { process.kill(pid, 0); return pid === process.pid ? String(process.pid) : "present"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return null; throw error; }
}

function names(count: number) { return [NAME, `${NAME}#m`, `${NAME}#p`, ...Array.from({ length: count }, (_, index) => `${NAME}#${index}`)]; }
function planned(raw: string | null, count: number): EntryMap {
  const result: EntryMap = Object.fromEntries(names(count).map(name => [name, null]));
  if (raw === null) return result;
  if (Buffer.byteLength(raw) <= CHUNK) { result[NAME] = raw; return result; }
  const encoded = Buffer.from(raw).toString("base64"), size = Math.ceil(encoded.length / CHUNK);
  if (size > count) throw new Error("Invalid journal layout");
  for (let index = 0; index < size; index++) result[`${NAME}#${index}`] = encoded.slice(index * CHUNK, (index + 1) * CHUNK);
  result[`${NAME}#m`] = JSON.stringify({ n: size, l: encoded.length });
  return result;
}

/** Complete encrypted write-ahead generations; never reconstructs a token from mixed fragments. */
export class ClaudeSecureJournal {
  private static reaping = new Map<string, Promise<void>>();
  private active = new Map<string, JournalWriter>();
  private processStart: Promise<string | null> | undefined;
  constructor(private directory: string, private secrets = new CredentialStore(), private identify = identifyProcess, private guard = withClaudeRecoveryMutex) {}
  writer(service: string) { return this.active.get(service); }
  private async file(profile: Profile) { return path.join(this.directory, hash(await realpath(profile.directory) + "\0" + profile.service) + ".json"); }
  private writerFile(loaded: Loaded) { return loaded.file + ".writer-" + loaded.payload.nonce + ".json"; }
  private async owner() {
    const start = await (this.processStart ??= this.identify(process.pid));
    if (!start) throw new Error("Claude 인증 저장 프로세스 소유권을 확인할 수 없습니다.");
    return { pid: process.pid, start };
  }
  private async safeRead(file: string, max: number) {
    const directory = await lstat(path.dirname(file)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!directory) return null;
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe credential journal directory");
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("Unsafe credential journal");
    return readFile(file, "utf8");
  }
  private async atomic(file: string, raw: string) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const directory = await lstat(path.dirname(file));
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("Unsafe credential journal directory");
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  private async load(profile: Profile): Promise<Loaded | null> {
    const file = await this.file(profile), raw = await this.safeRead(file, 8 * 1024 * 1024);
    if (raw === null) return null;
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    const password = await this.secrets.reveal(envelope.key);
    const payload = payloadSchema.parse(await decryptLocal(envelope.ciphertext, password));
    const expected = names(payload.count).sort();
    if (payload.nonce !== envelope.nonce || payload.directory !== await realpath(profile.directory) || payload.service !== profile.service || JSON.stringify(Object.keys(payload.original).sort()) !== JSON.stringify(expected)) throw changed();
    return { file, raw, envelope, payload, password };
  }
  private async persist(loaded: Loaded) {
    if (await this.safeRead(loaded.file, 8 * 1024 * 1024) !== loaded.raw) throw changed();
    loaded.envelope.ciphertext = await encryptLocal(loaded.payload, loaded.password);
    const raw = JSON.stringify(loaded.envelope);
    if (await this.safeRead(loaded.file, 8 * 1024 * 1024) !== loaded.raw) throw changed();
    await this.atomic(loaded.file, raw); loaded.raw = raw;
  }
  private async writerAlive(loaded: Loaded) {
    const raw = await this.safeRead(this.writerFile(loaded), 8192);
    if (raw === null) return false;
    const writer = writerSchema.parse(JSON.parse(raw));
    if (writer.nonce !== loaded.payload.nonce) throw changed();
    if (await this.identify(writer.pid) === writer.start) return true;
    await rm(this.writerFile(loaded));
    return false;
  }
  private async finish(loaded: Loaded) {
    if (await this.writerAlive(loaded)) throw activeWriter();
    if (await this.safeRead(loaded.file, 8 * 1024 * 1024) !== loaded.raw) throw changed();
    await rm(loaded.file);
    await this.secrets.remove(loaded.envelope.key);
  }

  async beforeLock(profile: Profile) {
    const file = await this.file(profile);
    if (await this.safeRead(file, 8 * 1024 * 1024) === null) return;
    const preceding = ClaudeSecureJournal.reaping.get(file);
    const pending = (preceding ?? Promise.resolve()).catch(() => {}).then(() => this.guard(file, verify => this.reap(profile, verify)));
    ClaudeSecureJournal.reaping.set(file, pending);
    try { await pending; } finally { if (ClaudeSecureJournal.reaping.get(file) === pending) ClaudeSecureJournal.reaping.delete(file); }
  }
  private async reap(profile: Profile, verify: () => void) {
    const loaded = await this.load(profile);
    if (!loaded || await this.identify(loaded.payload.owner.pid) === loaded.payload.owner.start || await this.writerAlive(loaded)) return;
    const resolved = await realpath(profile.directory);
    const expected = [path.join(resolved, ".oauth_refresh.lock"), resolved + ".lock", path.join(resolved, ".storage-write.lock")];
    if (loaded.payload.locks.some((entry, index) => entry.file !== expected[index])) throw changed();
    const matches = async (entry: ClaudeAuthLockEntry) => {
      const info = await lstat(entry.file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      return !info ? "missing" : info.isDirectory() && !info.isSymbolicLink() && info.birthtimeMs === entry.birthtime && info.ino === entry.ino ? "owned" : "foreign";
    };
    for (const entry of loaded.payload.locks) if (await matches(entry) === "foreign") return;
    for (const entry of [...loaded.payload.locks].reverse()) if (await matches(entry) === "owned") { verify(); await rmdir(entry.file); }
  }

  async recover(profile: Profile, io: JournalIO, retarget?: { raw: string | null; beforeMutation?: () => void }) {
    const loaded = await this.load(profile);
    if (!loaded) return false;
    await io.verify();
    if (await this.writerAlive(loaded)) throw activeWriter();
    if (loaded.payload.context !== await io.context()) { await this.finish(loaded); if (retarget) throw changed(); return true; }
    if (retarget) {
      if (retarget.raw !== loaded.payload.previous && retarget.raw !== loaded.payload.next) throw changed();
      loaded.payload.goal = retarget.raw === loaded.payload.next ? "next" : "previous";
    }
    const previous = planned(loaded.payload.previous, loaded.payload.count), next = planned(loaded.payload.next, loaded.payload.count);
    const current = Object.fromEntries(await Promise.all(names(loaded.payload.count).map(async name => [name, await io.readEntry(name)] as const)));
    const compatible = Object.entries(current).every(([name, value]) => new Set([null, loaded.payload.original[name], previous[name], next[name], ...(name === `${NAME}#p` ? [String(loaded.payload.count)] : [])]).has(value));
    const desired = loaded.payload[loaded.payload.goal];
    const empty = Object.values(current).every(value => value === null);
    if (!compatible || empty && desired !== null) {
      // An independently complete login/logout supersedes an old interrupted restore.
      const raw = await io.readComplete();
      if (raw !== null) { const value = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw changed(); }
      await this.finish(loaded);
      if (retarget) throw changed();
      return true;
    }
    const desiredLayout = planned(desired, loaded.payload.count);
    // Persist rollback intent and the new lease even when the desired bytes are already complete.
    loaded.payload.owner = await this.owner(); loaded.payload.locks = io.locks();
    await this.persist(loaded);
    await io.verify();
    if (loaded.payload.context !== await io.context()) throw changed();
    for (const [name, value] of Object.entries(current)) if (await io.readEntry(name) !== value) throw changed();
    if (!Object.entries(current).every(([name, value]) => value === desiredLayout[name])) {
      this.active.set(profile.service, { file: this.writerFile(loaded), nonce: loaded.payload.nonce, owner: loaded.payload.owner });
      try { await io.writeComplete(desired, retarget?.beforeMutation); } finally { this.active.delete(profile.service); }
    }
    await io.verify();
    for (const [name, value] of Object.entries(desiredLayout)) if (await io.readEntry(name) !== value) throw changed();
    await this.finish(loaded);
    return true;
  }

  async write(profile: Profile, io: JournalIO, raw: string | null, expected: string | null | undefined, beforeMutation?: () => void) {
    const existed = await this.safeRead(await this.file(profile), 8 * 1024 * 1024) !== null;
    if (existed) {
      await this.recover(profile, io, { raw, beforeMutation });
      if (await io.readComplete() === raw) return;
    }
    const previous = await io.readComplete();
    if (expected !== undefined && previous !== expected) throw changed();
    const meta = await io.readEntry(`${NAME}#m`), pending = await io.readEntry(`${NAME}#p`);
    const oldCount = meta ? JSON.parse(meta).n : 0, pendingCount = pending === null ? 0 : Number(pending);
    const nextCount = raw !== null && Buffer.byteLength(raw) > CHUNK ? Math.ceil(Buffer.from(raw).toString("base64").length / CHUNK) : 0;
    const count = Math.max(oldCount, pendingCount, nextCount);
    if (!Number.isInteger(count) || count < 0 || count > MAX_CHUNKS) throw changed();
    const original = Object.fromEntries(await Promise.all(names(count).map(async name => [name, await io.readEntry(name)] as const)));
    const nonce = randomUUID(), password = randomBytes(32).toString("hex");
    const key = await this.secrets.protect(password);
    const payload: Payload = { version: 1, nonce, directory: await realpath(profile.directory), service: profile.service, context: await io.context(), owner: await this.owner(), locks: io.locks(), count, original, previous, next: raw, goal: "next" };
    const envelope = { version: 1 as const, nonce, key, ciphertext: await encryptLocal(payload, password) };
    const file = await this.file(profile), encoded = JSON.stringify(envelope);
    await io.verify();
    if (await this.safeRead(file, 8 * 1024 * 1024) !== null) throw changed();
    await this.atomic(file, encoded);
    const loaded: Loaded = { file, raw: encoded, envelope, payload, password };
    let started = false;
    this.active.set(profile.service, { file: this.writerFile(loaded), nonce, owner: payload.owner });
    try {
      await io.verify();
      if (payload.context !== await io.context()) throw changed();
      for (const [name, value] of Object.entries(original)) if (await io.readEntry(name) !== value) throw changed();
      await io.writeComplete(raw, () => { started = true; beforeMutation?.(); });
      await io.verify();
      for (const [name, value] of Object.entries(planned(raw, count))) if (await io.readEntry(name) !== value) throw changed();
      await this.finish(loaded);
    } catch (error) {
      if (!started) await this.finish(loaded);
      throw error;
    } finally { this.active.delete(profile.service); }
  }
}
