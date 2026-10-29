import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "./accounts.ts";
import type { Binding } from "./scheduler.ts";

const recordSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("managed"), accountId: z.string().min(1).max(200), accountKey: z.string().regex(/^[a-f0-9]{64}$/), switchedAt: z.number().finite().nonnegative() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("excluded") }).strict(),
]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const accountKey = (account: Account) => digest(account.identity?.trim() || account.email?.trim().toLowerCase() || account.home);
export type CachedRoute = { kind: "managed"; binding: Binding } | { kind: "excluded" };

/** Advisory device-local routing metadata. Never reads or stores credentials. */
export class RoutingCache {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly warn = (message: string) => console.warn(message), private readonly replace = rename) {}

  private serial<T>(action: () => Promise<T>) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private file(agentId: string) { return join(this.directory, digest(agentId) + ".json"); }
  private async regular(file: string, directory = false, maxSize = 4096) {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.size > maxSize))) throw new Error("Unsafe routing cache");
    return info;
  }

  load(agentId: string, accounts: readonly Account[], now = Date.now()): Promise<CachedRoute | null> {
    return this.serial(async () => {
      try {
        if (!await this.regular(this.directory, true) || !await this.regular(this.file(agentId))) return null;
        const value = recordSchema.parse(JSON.parse(await readFile(this.file(agentId), "utf8")));
        if (value.kind === "excluded") return { kind: "excluded" };
        if (value.switchedAt > now) return null;
        const matches = (account: Account) => accountKey(account) === value.accountKey;
        const account = accounts.find(account => account.id === value.accountId && matches(account)) ?? accounts.find(matches);
        return account ? { kind: "managed", binding: { accountId: account.id, switchedAt: value.switchedAt } } : null;
      } catch {
        this.warn(`[aster] session ${agentId}: 계정 연결 캐시를 읽지 못해 현재 계정 정보로 진행`);
        return null;
      }
    });
  }

  save(agentId: string, account: Account, binding: Binding) {
    return this.put(agentId, { version: 1, kind: "managed", accountId: account.id, accountKey: accountKey(account), switchedAt: binding.switchedAt });
  }
  exclude(agentId: string) { return this.put(agentId, { version: 1, kind: "excluded" }); }
  private put(agentId: string, value: z.infer<typeof recordSchema>) {
    return this.serial(async () => {
      const temporary = this.file(agentId) + "." + randomUUID() + ".tmp";
      try {
        const raw = JSON.stringify(recordSchema.parse(value));
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.regular(this.directory, true);
        const previous = await this.regular(this.file(agentId), false, Infinity);
        if (previous && previous.size <= 4096 && await readFile(this.file(agentId), "utf8") === raw) return true;
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
        await this.replace(temporary, this.file(agentId));
        return true;
      } catch {
        this.warn(`[aster] session ${agentId}: 계정 연결 캐시 저장 실패, 현재 연결은 유지`);
        return false;
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
  }
  forget(agentId: string) {
    return this.serial(async () => {
      try {
        if (!await this.regular(this.directory, true)) return;
        await this.regular(this.file(agentId));
        await rm(this.file(agentId), { force: true });
      } catch { this.warn(`[aster] session ${agentId}: 계정 연결 캐시 정리 실패`); }
    });
  }
}
