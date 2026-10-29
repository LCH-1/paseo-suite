import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

/** The OS releases this mutex if either the parent pipe or its helper process dies. */
export async function withClaudeRecoveryMutex<T>(key: string, action: (verify: () => void) => Promise<T>): Promise<T> {
  if (process.platform !== "win32") return action(() => {});
  const name = "Local\\PaseoClaudeRecovery-" + createHash("sha256").update(key.toLowerCase()).digest("hex");
  const script = "$ErrorActionPreference='Stop'; $mutex=New-Object Threading.Mutex($false,'" + name + "'); $held=$false; try { try {$held=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$held=$true}; if(-not $held){exit 2}; [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine()|Out-Null; } finally {if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}";
  const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "pipe" });
  const failure = () => new Error("Claude 인증 복구를 다른 프로세스가 수행 중이거나 복구 잠금을 확인할 수 없습니다. 잠시 후 다시 동기화하세요.");
  let rejectReady: (error: Error) => void, ready = false, alive = true;
  let output = "";
  const acquired = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.trim() === "locked") { ready = true; resolve(); }
      else if (output.length > 100) reject(failure());
    });
    child.on("error", () => reject(failure()));
  });
  child.stderr.resume(); child.stdin.on("error", () => rejectReady(failure()));
  const closed = new Promise<number | null>(resolve => child.on("close", code => { alive = false; if (!ready) rejectReady(failure()); resolve(code); }));
  const timer = setTimeout(() => { rejectReady(failure()); child.kill(); }, 10_000);
  try {
    await acquired; clearTimeout(timer);
    const result = await action(() => { if (!alive) throw failure(); });
    child.stdin.end("release\n");
    if (await closed !== 0) throw failure();
    return result;
  } finally { clearTimeout(timer); child.stdin.end(); await closed; }
}
