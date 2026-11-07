import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const systemProgram = (name: string) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
/** A Windows profile grants inherited read access to other groups, which mode bits cannot remove. */
export function ownerOnlyArguments(target: string, userSid: string, inherit = false) {
  const flags = inherit ? "(OI)(CI)F" : "F";
  return [target, "/inheritance:r", "/grant:r", `*${userSid}:${flags}`, `*S-1-5-18:${flags}`];
}
/** SIDs, because account and group names are localized and may need a domain to resolve. */
async function restrictOnWindows(target: string, inherit = false) {
  const sid = (await run(systemProgram("whoami.exe"), ["/user", "/fo", "csv", "/nh"])).match(/S-1-[\d-]+/)?.[0];
  if (!sid) throw new Error("Windows user SID not found");
  await run(systemProgram("icacls.exe"), ownerOnlyArguments(target, sid, inherit));
}
export type Restrict = (target: string) => Promise<void>;
export const ownerOnlyFile = (platform: NodeJS.Platform, restrict?: Restrict): Restrict | null =>
  platform === "win32" ? (restrict ?? ((target) => restrictOnWindows(target))) : null;
export const ownerOnlyDirectory = (platform: NodeJS.Platform, restrict?: Restrict): Restrict | null =>
  platform === "win32" ? (restrict ?? ((target) => restrictOnWindows(target, true))) : null;

/** Restricted before it takes the name, so a failure leaves whatever was there untouched. */
export async function writeOwnerOnly(file: string, raw: string, restrict: Restrict | null) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
    await restrict?.(temporary);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
