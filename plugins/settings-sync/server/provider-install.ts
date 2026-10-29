import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { resolveInstalledExecutable, type MaterializeOptions } from "./provider-paths";

export type ProviderInstallRunOptions = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number };
export type ProviderInstallRunner = (executable: string, args: string[], options: ProviderInstallRunOptions) => Promise<void>;
export type ProviderInstallOptions = MaterializeOptions & { paseoHome?: string; arch?: NodeJS.Architecture; fetch?: typeof fetch; run?: ProviderInstallRunner };
const SCRIPT_LIMIT = 2 * 1024 * 1024;
const ARCHIVE_LIMIT = 256 * 1024 * 1024;
const INFLATED_LIMIT = 1024 * 1024 * 1024;
const installs = new Map<string, Promise<string>>();

export const runProviderInstaller: ProviderInstallRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = 0; let finished = false;
  const finish = (ok: boolean) => {
    if (finished) return;
    finished = true; clearTimeout(timer);
    if (ok) resolve(); else { child.kill(); reject(new Error("공식 CLI 설치 프로그램을 완료하지 못했습니다.")); }
  };
  const timer = setTimeout(() => finish(false), options.timeoutMs);
  const inspect = (chunk: Buffer) => { output += chunk.length; if (output > options.maxOutputBytes) finish(false); };
  child.stdout.on("data", inspect); child.stderr.on("data", inspect);
  child.on("error", () => finish(false)); child.on("close", (code) => finish(code === 0));
});

function within(root: string, file: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function directory(root: string, relative: string) {
  let current = path.resolve(root);
  await mkdir(current, { recursive: true, mode: 0o700 });
  for (const part of ["", ...relative.split("/").filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    await mkdir(current, { recursive: true, mode: 0o700 });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("CLI 설치 디렉터리를 안전하게 사용할 수 없습니다.");
  }
  return current;
}

async function download(url: string, limit: number, request: typeof fetch, allowed: (url: URL) => boolean): Promise<Buffer> {
  let target = new URL(url);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (target.protocol !== "https:" || target.username || target.password || !allowed(target)) throw new Error("허용하지 않는 CLI 다운로드 경로입니다.");
    const response = await request(target, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: { Accept: "application/octet-stream", "User-Agent": "Paseo-Settings-Sync" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      if (!next) throw new Error("공식 CLI 다운로드 위치를 확인할 수 없습니다.");
      target = new URL(next, target); continue;
    }
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) throw new Error("공식 CLI 다운로드에 실패했거나 크기 제한을 초과했습니다.");
    const chunks: Buffer[] = []; let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) { await reader.cancel(); throw new Error("공식 CLI 다운로드 크기 제한을 초과했습니다."); }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  throw new Error("공식 CLI 다운로드 리디렉션이 너무 많습니다.");
}

const field = (buffer: Buffer) => buffer.toString("utf8").split("\0")[0];
function archivePath(value: string) {
  const name = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes(":") || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Codex 압축파일에 허용하지 않는 경로가 있습니다.");
  return name;
}
export function readCodexArchive(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive, { maxOutputLength: INFLATED_LIMIT });
  const files = new Map<string, Buffer>(); let nextName: string | null = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const sizeText = field(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Codex 압축파일 크기 정보를 읽을 수 없습니다.");
    const size = Number.parseInt(sizeText, 8);
    if (size > 512 * 1024 * 1024 || offset + size > tar.length) throw new Error("Codex 압축파일이 손상되었거나 너무 큽니다.");
    const checksum = Number.parseInt(field(header.subarray(148, 156)).trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error("Codex 압축파일 헤더 검증에 실패했습니다.");
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const prefix = field(header.subarray(345, 500));
    const fullName = nextName ?? [prefix, field(header.subarray(0, 100))].filter(Boolean).join("/"); nextName = null;
    if (type === "L") { nextName = field(body).replace(/\n$/, ""); continue; }
    if (type === "x" || type === "g") {
      for (const line of body.toString("utf8").split("\n").filter(Boolean)) {
        const entry = line.slice(line.indexOf(" ") + 1); const separator = entry.indexOf("=");
        if (entry.slice(0, separator) === "linkpath") throw new Error("Codex 압축파일에 링크를 사용할 수 없습니다.");
        if (entry.slice(0, separator) === "path") nextName = entry.slice(separator + 1);
      }
      continue;
    }
    if (type === "5" && (fullName === "." || fullName === "./")) continue;
    const name = archivePath(fullName);
    if (type === "5") continue;
    if (type !== "0" || files.has(name) || files.size >= 500) throw new Error("Codex 압축파일에 링크나 중복 파일을 사용할 수 없습니다.");
    files.set(name, body);
  }
  if (!files.size) throw new Error("Codex 압축파일에 설치할 파일이 없습니다.");
  return files;
}

function nativeBinary(buffer: Buffer, platform: NodeJS.Platform) {
  if (platform === "win32") return buffer[0] === 0x4d && buffer[1] === 0x5a;
  if (platform === "linux") return buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(buffer.subarray(0, 4).toString("hex"));
}

async function codex(root: string, temporary: string, options: ProviderInstallOptions) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  const system = platform === "win32" ? "pc-windows-msvc" : platform === "linux" ? "unknown-linux-musl" : platform === "darwin" ? "apple-darwin" : null;
  if (!cpu || !system) throw new Error("이 운영체제 또는 CPU의 Codex 자동 설치는 지원하지 않습니다.");
  const request = options.fetch ?? fetch;
  const metadata = JSON.parse((await download("https://api.github.com/repos/openai/codex/releases/latest", SCRIPT_LIMIT, request, (url) => url.hostname === "api.github.com" && url.pathname === "/repos/openai/codex/releases/latest")).toString("utf8"));
  const tag = metadata.tag_name;
  if (typeof tag !== "string" || !/^rust-v[0-9][a-zA-Z0-9._-]*$/.test(tag) || !Array.isArray(metadata.assets)) throw new Error("공식 Codex 릴리즈 정보를 확인할 수 없습니다.");
  const name = `codex-package-${cpu}-${system}.tar.gz`;
  const asset = metadata.assets.find((entry: any) => entry.name === name);
  const url = `https://github.com/openai/codex/releases/download/${tag}/${name}`;
  if (!asset || asset.browser_download_url !== url || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error("공식 Codex 릴리즈의 파일과 SHA256을 확인할 수 없습니다.");
  const archive = await download(url, ARCHIVE_LIMIT, request, (target) => target.hostname === "github.com" && target.pathname === `/openai/codex/releases/download/${tag}/${name}` || target.hostname === "release-assets.githubusercontent.com");
  if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== asset.digest) throw new Error("Codex 다운로드 SHA256 검증에 실패했습니다.");
  const files = readCodexArchive(archive);
  const binaries = [...files].filter(([file, content]) => ["codex", "codex.exe", `codex-${cpu}-${system}${platform === "win32" ? ".exe" : ""}`].includes(path.posix.basename(file)) && nativeBinary(content, platform));
  if (binaries.length !== 1) throw new Error("공식 Codex 실행 파일을 압축파일에서 확인할 수 없습니다.");
  const staged = await directory(temporary, "payload");
  for (const [name, contents] of files) {
    const destination = path.join(staged, ...name.split("/"));
    if (!within(staged, destination)) throw new Error("Codex 파일 경로가 설치 디렉터리를 벗어났습니다.");
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { mode: 0o700, flag: "wx" });
    await chmod(destination, 0o700);
  }
  const installed = path.join(root, `codex-${tag}-${platform}-${arch}`);
  if (!within(root, installed)) throw new Error("Codex 설치 경로가 올바르지 않습니다.");
  await rename(staged, installed);
  const relative = path.join(path.basename(installed), ...binaries[0][0].split("/"));
  await writeFile(path.join(root, "codex-install.json"), JSON.stringify({ version: 1, path: relative }), { mode: 0o600 });
  return path.join(root, relative);
}

async function script(name: "claude" | "cursor-agent", temporary: string, options: ProviderInstallOptions) {
  const platform = options.platform ?? process.platform;
  if (!["win32", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(options.arch ?? process.arch)) throw new Error("이 운영체제 또는 CPU의 CLI 자동 설치는 지원하지 않습니다.");
  const windows = platform === "win32";
  const url = name === "claude" ? `https://claude.ai/install.${windows ? "ps1" : "sh"}` : `https://cursor.com/install${windows ? "?win32=true" : ""}`;
  const domain = name === "claude" ? "claude.ai" : "cursor.com";
  const content = await download(url, SCRIPT_LIMIT, options.fetch ?? fetch, (target) => target.hostname === domain || target.hostname.endsWith(`.${domain}`));
  if (!content.length || content.includes(0)) throw new Error("공식 CLI 설치 스크립트를 확인할 수 없습니다.");
  const file = path.join(temporary, windows ? "official-install.ps1" : "official-install.sh");
  await writeFile(file, content, { mode: 0o700, flag: "wx" });
  const home = options.home ?? homedir();
  const environment: NodeJS.ProcessEnv = { ...process.env, ...options.env, HOME: home, USERPROFILE: home };
  const run = options.run ?? runProviderInstaller;
  const executable = windows ? path.win32.join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/bash";
  const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file] : [file];
  await run(executable, args, { cwd: temporary, env: environment, timeoutMs: 240_000, maxOutputBytes: 2 * 1024 * 1024 });
  const resolved = await (options.resolveExecutable ?? ((command) => resolveInstalledExecutable(command, options)))(name);
  if (!resolved) throw new Error("공식 설치 후에도 CLI 실행 파일을 찾지 못했습니다. 설치 경로와 권한을 확인하세요.");
  return resolved;
}

async function install(name: string, options: ProviderInstallOptions): Promise<string> {
  const root = await directory(options.paseoHome ?? path.join(options.home ?? homedir(), ".paseo"), "settings-sync/tools");
  if (name === "codex") {
    try {
      const record = JSON.parse(await readFile(path.join(root, "codex-install.json"), "utf8"));
      const file = path.resolve(root, record.path);
      if (record.version !== 1 || typeof record.path !== "string" || !within(root, file) || !(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error("기존 Codex 설치 기록을 확인할 수 없습니다.");
      return file;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const temporary = await mkdtemp(path.join(root, "install-"));
  try { return name === "codex" ? await codex(root, temporary, options) : await script(name as "claude" | "cursor-agent", temporary, options); }
  finally {
    if (!within(root, temporary) || !/^install-[a-zA-Z0-9]+$/.test(path.basename(temporary))) throw new Error("CLI 임시 설치 경로를 안전하게 정리할 수 없습니다.");
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureProviderExecutable(name: string, options: ProviderInstallOptions = {}): Promise<string> {
  const existing = await (options.resolveExecutable ?? ((command) => resolveInstalledExecutable(command, options)))(name);
  if (existing) return existing;
  if (!["claude", "codex", "cursor-agent"].includes(name)) throw new Error("이 CLI는 자동 설치를 지원하지 않습니다. 해당 프로바이더의 공식 CLI를 먼저 설치하세요.");
  const key = `${path.resolve(options.paseoHome ?? path.join(options.home ?? homedir(), ".paseo"))}:${name}`;
  const pending = installs.get(key);
  if (pending) return pending;
  const task = install(name, options).catch(() => { throw new Error(`${name} 공식 CLI 자동 설치에 실패했습니다. 네트워크·설치 권한과 공식 설치 요구사항을 확인하세요.`); }).finally(() => installs.delete(key));
  installs.set(key, task);
  return task;
}
