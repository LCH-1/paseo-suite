import type { RpcInput } from "@getpaseo/plugin";
import type { ConnectionState } from "../shared/rpc";
import type { manualRpc } from "../shared/manual-restore-rpc";
import type { AutoScopes } from "../shared/automation";

export type LoginFlow = { flowId: string; code: string | null; url: string | null; expires: number; ready: boolean; login: string | null };
export type PendingManualRestore = {
  input: RpcInput<typeof manualRpc.restoreStart>; scopes: AutoScopes; before: string;
  phase: "server" | "applied" | "skipped" | "failed"; backupDirectory?: string; message?: string;
};
type Remembered = { connection: ConnectionState | null; flow: LoginFlow | null; expires: number; pending?: PendingManualRestore; runner?: symbol };

export class SessionMemory {
  private entries = new Map<string, Remembered>();
  constructor(private now = Date.now) {}

  read(host: string) {
    const entry = this.entries.get(host);
    if (!entry || entry.expires <= this.now()) { this.entries.delete(host); return null; }
    return entry;
  }
  connection(host: string, connection: ConnectionState) {
    const previous = this.read(host);
    this.entries.set(host, { connection, flow: null, expires: this.now() + 30 * 60_000, ...(previous?.connection?.sessionId === connection.sessionId && previous.pending ? { pending: previous.pending } : {}) });
  }
  pending(host: string, pending: PendingManualRestore) {
    const entry = this.read(host);
    if (entry?.connection?.sessionId !== pending.input.sessionId) throw new Error("복원 연결이 변경되었습니다. 다시 연결하세요.");
    entry.pending = structuredClone(pending);
    entry.expires = this.now() + 30 * 60_000;
  }
  clearPending(host: string, previewId: string) {
    const entry = this.read(host);
    if (entry?.pending?.input.previewId === previewId) { delete entry.pending; delete entry.runner; }
  }
  claimRestore(host: string) {
    const entry = this.read(host);
    if (!entry?.pending) throw new Error("이어받을 복원 작업이 없습니다.");
    const runner = Symbol();
    entry.runner = runner;
    return () => this.read(host)?.runner === runner;
  }
  flow(host: string, flow: LoginFlow) {
    this.entries.set(host, { connection: null, flow, expires: flow.expires });
  }
  forget(host: string) { this.entries.delete(host); }
}

export const sessionMemory = new SessionMemory();
