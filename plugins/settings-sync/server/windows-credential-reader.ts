import { spawn } from "node:child_process";
import path from "node:path";

// Every read used to start its own PowerShell process and compile this type again, dozens of times
// a minute. One helper now stays up between reads and answers them over its pipes. It declares the
// read call only, so a process that outlives a request can never change a login: writes keep
// running as their own short-lived process under the write journal.
// The loop must never mention PowerShell's $input: the host would then read the requests itself.
export const WINDOWS_CREDENTIAL_READER_SCRIPT = String.raw`$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class PaseoProviderCredentialReader {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadNative(string target,UInt32 type,UInt32 flags,out IntPtr value);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static object Read(string target) { IntPtr pointer; if(!ReadNative(target,1,0,out pointer)) { if(Marshal.GetLastWin32Error()==1168)return null; throw new Win32Exception(); } try { var credential=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential)); if(credential.CredentialBlobSize>1048576)throw new Exception(); var bytes=new byte[credential.CredentialBlobSize]; Marshal.Copy(credential.CredentialBlob,bytes,0,bytes.Length); long stamp=((long)(uint)credential.LastWritten.dwHighDateTime<<32)|(uint)credential.LastWritten.dwLowDateTime; return new {value=Convert.ToBase64String(bytes),updatedAt=(DateTime.FromFileTimeUtc(stamp)-new DateTime(1970,1,1)).TotalMilliseconds,persistence=credential.Persist}; } finally { CredFree(pointer); } }
}
'@
} catch { [Console]::Error.Write('Provider credential store failed.'); exit 1 }
while($true) {
 $line=[Console]::In.ReadLine()
 if($null -eq $line){break}
 $reply=@{id=$null;ok=$false}
 try {
  $request=$line|ConvertFrom-Json
  $reply.id=$request.id
  if($request.operation -ne 'read' -or $request.target -isnot [string] -or $request.target.Length -eq 0){throw 'request'}
  $reply.result=[PaseoProviderCredentialReader]::Read($request.target)
  $reply.ok=$true
 } catch {}
 [Console]::Out.WriteLine(($reply|ConvertTo-Json -Compress -Depth 3))
 [Console]::Out.Flush()
}`;

const LIMIT = 1_048_576;
interface Pipe {
  ref?(): unknown;
  unref?(): unknown;
}
/** The part of a child process the reader relies on, so tests can count and script helpers. */
export interface WindowsCredentialReaderProcess extends Pipe {
  stdin: Pipe & { write(line: string): unknown; on(event: "error", listener: () => void): unknown };
  stdout: Pipe & { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: Pipe & { resume(): unknown };
  on(event: "error" | "close", listener: () => void): unknown;
  kill(): unknown;
}
export interface WindowsCredentialReaderOptions {
  systemRoot?: string;
  spawn?: (executable: string, args: string[]) => WindowsCredentialReaderProcess;
  /** Longer than the gap between two periodic checks, so steady use keeps a single process. */
  idleMs?: number;
  requestTimeoutMs?: number;
  retryMs?: number;
  now?: () => number;
}
type Request = { resolve(raw: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Session = {
  process: WindowsCredentialReaderProcess;
  pending: Map<number, Request>;
  buffer: string;
  idle?: ReturnType<typeof setTimeout>;
  ended: boolean;
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const unavailable = () => new Error("Windows credential reader is unavailable.");
// The helper decodes its input with the console code page, which is not UTF-8 everywhere.
const ascii = (json: string) => json.replace(/[\u007f-\uffff]/g, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
const hold = (child: WindowsCredentialReaderProcess, referenced: boolean) => {
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) (referenced ? handle.ref : handle.unref)?.call(handle);
};

/**
 * Nothing is remembered between reads: each one asks the store again, so a login the CLI renewed a
 * moment ago is what the next read returns. A read this cannot answer rejects, and the caller then
 * decides with the one-shot process instead.
 */
export class WindowsCredentialReader {
  private session: Session | null = null;
  private sequence = 0;
  private retryAt = 0;
  constructor(private readonly options: WindowsCredentialReaderOptions = {}) {}

  private get now() {
    return (this.options.now ?? Date.now)();
  }
  /** Resolves to the text the one-shot helper prints: "null" for a missing entry, else its JSON. */
  read(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let session: Session;
      try {
        session = this.open();
      } catch {
        reject(unavailable());
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => this.end(session, true), this.options.requestTimeoutMs ?? 20_000);
      session.pending.set(id, { resolve, reject, timer });
      clearTimeout(session.idle);
      // An unanswered read must keep its process alive, an idle helper must not.
      hold(session.process, true);
      try {
        session.process.stdin.write(ascii(JSON.stringify({ id, operation: "read", target })) + "\n");
      } catch {
        this.end(session, true);
      }
    });
  }
  dispose() {
    if (this.session) this.end(this.session, false);
  }
  private open(): Session {
    if (this.session) return this.session;
    if (this.now < this.retryAt) throw unavailable();
    const systemRoot = this.options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
    const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_CREDENTIAL_READER_SCRIPT, "utf16le").toString("base64")];
    let child: WindowsCredentialReaderProcess;
    try {
      // It outlives single requests, so it must not keep the plugin's working directory in use.
      child = this.options.spawn ? this.options.spawn(executable, args) : spawn(executable, args, { windowsHide: true, stdio: "pipe", cwd: systemRoot });
    } catch (error) {
      this.backOff();
      throw error;
    }
    const session: Session = { process: child, pending: new Map(), buffer: "", ended: false };
    this.session = session;
    child.stdout.on("data", (chunk) => this.receive(session, chunk.toString()));
    child.stderr.resume();
    child.on("error", () => this.end(session, true));
    child.on("close", () => this.end(session, true));
    child.stdin.on("error", () => this.end(session, true));
    return session;
  }
  /** A helper that cannot run must not cost an extra process on every read. */
  private backOff() {
    this.retryAt = this.now + (this.options.retryMs ?? 5 * 60_000);
    console.warn("[settings-sync] Windows 자격증명 조회 도우미를 사용할 수 없어 한동안 조회마다 별도 프로세스로 읽습니다.");
  }
  private receive(session: Session, text: string) {
    if (session.ended) return;
    session.buffer += text;
    for (let end = session.buffer.indexOf("\n"); end >= 0; end = session.buffer.indexOf("\n")) {
      const line = session.buffer.slice(0, end).trim();
      session.buffer = session.buffer.slice(end + 1);
      // Output that is not an answer to a pending read means the pairing can no longer be trusted.
      if (line && !this.answer(session, line)) return this.end(session, true);
    }
    if (session.buffer.length > LIMIT * 2) this.end(session, true);
  }
  private answer(session: Session, line: string) {
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      return false;
    }
    const request = object(reply) && typeof reply.id === "number" ? session.pending.get(reply.id) : undefined;
    if (!object(reply) || !request) return false;
    session.pending.delete(reply.id as number);
    clearTimeout(request.timer);
    // Only an explicit null is a missing entry; a failed read never passes for one.
    if (reply.ok === true && reply.result === null) request.resolve("null");
    else if (reply.ok === true && object(reply.result)) request.resolve(JSON.stringify(reply.result));
    else request.reject(unavailable());
    if (!session.pending.size) {
      hold(session.process, false);
      session.idle = setTimeout(() => this.end(session, false), this.options.idleMs ?? 2 * 60_000);
      session.idle.unref?.();
    }
    return true;
  }
  private end(session: Session, failed: boolean) {
    if (session.ended) return;
    session.ended = true;
    if (this.session === session) this.session = null;
    clearTimeout(session.idle);
    if (failed) this.backOff();
    for (const request of session.pending.values()) {
      clearTimeout(request.timer);
      request.reject(unavailable());
    }
    session.pending.clear();
    try {
      session.process.kill();
    } catch {
      /* Already gone. */
    }
  }
}

const sharedKey = Symbol.for("paseo.settings-sync.windows-credential-reader.v1");
/** The backup runtime is bundled apart from the relay, and both must still share one helper. */
export function sharedWindowsCredentialReader(systemRoot = process.env.SystemRoot ?? "C:\\Windows"): WindowsCredentialReader {
  const scope = globalThis as typeof globalThis & { [sharedKey]?: Map<string, WindowsCredentialReader> };
  const readers = (scope[sharedKey] ??= new Map());
  let reader = readers.get(systemRoot);
  if (!reader) readers.set(systemRoot, (reader = new WindowsCredentialReader({ systemRoot })));
  return reader;
}
