import { lstat, mkdir, readFile, realpath, rm, rmdir, utimes } from "node:fs/promises";
import path from "node:path";

const busy = () => new Error("Claude 인증 갱신 또는 저장 잠금이 사용 중입니다. 현재 인증을 보존했으니 잠시 후 다시 동기화하세요.");
export type ClaudeAuthLockEntry = { file: string; birthtime: number; ino: number };

// A CLI that died mid-refresh leaves its lock behind and would block this profile forever.
// Only a lock with a recorded owner that is gone and has stopped being touched is reclaimed.
async function reapDeadCliLock(file: string, legacy: string) {
  let owner: { pid?: unknown };
  try { owner = JSON.parse(await readFile(file + ".owner", "utf8")); } catch { return false; }
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  const age = async (target: string) => Date.now() - (await lstat(target)).mtimeMs;
  if (await age(file).catch(() => 0) < 60000) return false;
  await rmdir(file).catch(() => {});
  await rm(file + ".owner", { force: true }).catch(() => {});
  if (await age(legacy).catch(() => 0) >= 60000) await rmdir(legacy).catch(() => {});
  return true;
}

export async function lockClaudeAuthentication(directory: string) {
  const resolved = await realpath(directory);
  const held: ClaudeAuthLockEntry[] = [];
  let stopped = false;
  let compromised = false;
  let updating = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  const check = () => { if (compromised) throw busy(); };
  const matches = async (entry: typeof held[number]) => {
    const stat = await lstat(entry.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return stat?.isDirectory() && !stat.isSymbolicLink() && stat.birthtimeMs === entry.birthtime && stat.ino === entry.ino;
  };
  const verify = async () => {
    check();
    for (const entry of held) {
      if (!await matches(entry)) { compromised = true; throw busy(); }
    }
    check();
  };
  const release = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await updating;
    const failures: unknown[] = [];
    for (const entry of [...held].reverse()) {
      try {
        if (!await matches(entry)) { compromised = true; continue; }
        await rmdir(entry.file);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error("Claude 인증 저장 잠금 해제에 실패했습니다.");
  };
  try {
    await reapDeadCliLock(path.join(resolved, ".oauth_refresh.lock"), `${resolved}.lock`);
    // Match the CLI's refresh → legacy refresh → storage write order.
    for (const file of [path.join(resolved, ".oauth_refresh.lock"), `${resolved}.lock`, path.join(resolved, ".storage-write.lock")]) {
      try { await mkdir(file, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy(); throw error; }
      const stat = await lstat(file);
      held.push({ file, birthtime: stat.birthtimeMs, ino: stat.ino });
    }
    timer = setInterval(() => {
      updating = updating.then(async () => {
        if (stopped) return;
        for (const entry of held) {
          if (!await matches(entry)) { compromised = true; return; }
          const now = new Date();
          await utimes(entry.file, now, now);
        }
      }).catch(() => { compromised = true; });
    }, 5000);
    timer.unref();
    return { check, verify, release, snapshot: () => held.map(entry => ({ ...entry })) };
  } catch (error) {
    await release();
    throw error;
  }
}
