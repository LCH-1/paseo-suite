import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { manualRpc } from "../shared/manual-restore-rpc";
import { normalizeScopes, stableString } from "../shared/automation";
import { capture, restore, type StorageAdapter } from "./storage";
import type { SessionMemory } from "./session";

type Calls = {
  start(input: RpcInput<typeof manualRpc.restoreStart>): Promise<RpcOutput<typeof manualRpc.restoreStart>>;
  status(input: RpcInput<typeof manualRpc.restoreStatus>): Promise<RpcOutput<typeof manualRpc.restoreStatus>>;
  release(input: RpcInput<typeof manualRpc.restoreRelease>): Promise<unknown>;
};

export async function finishManualRestore(options: {
  host: string; memory: SessionMemory; storage: StorageAdapter; calls: Calls; active: () => boolean;
  wait?: () => Promise<void>;
}) {
  const { host, memory, storage, calls } = options;
  let pending = memory.read(host)?.pending;
  if (!pending) throw new Error("이어받을 복원 작업이 없습니다.");
  const { input } = pending;
  if (!options.active()) return null;
  const owns = memory.claimRestore(host);
  const active = () => options.active() && owns() && memory.read(host)?.pending?.input.sessionId === input.sessionId && memory.read(host)?.pending?.input.previewId === input.previewId;
  const key = { sessionId: input.sessionId, previewId: input.previewId };
  if (!active()) return null;
  if (pending.phase === "server") {
    let status = await calls.start(input);
    if (!active()) return null;
    while (status.state === "running") {
      await (options.wait?.() ?? new Promise<void>((done) => setTimeout(done, 1500)));
      if (!active()) return null;
      status = await calls.status(key);
      if (!active()) return null;
      memory.pending(host, pending);
    }
    if (status.state === "missing") throw new Error("복원 작업을 찾을 수 없습니다. 연결을 다시 설정하고 새 미리보기를 여세요.");
    if (status.state === "failed") pending = { ...pending, phase: "failed", message: status.message };
    else {
      const { result } = status;
      try {
        const scopes = normalizeScopes(result.scopes ?? pending.scopes);
        const current = stableString(capture(storage, pending.scopes));
        let alreadyApplied = false;
        if (current !== pending.before) {
          // Another window or automatic sync may have applied this same goal.
          // Project it without writing the real store, preserving local-only data.
          const values = new Map<string, string | null>();
          const projected: StorageAdapter = {
            getItem: (key) => values.has(key) ? values.get(key)! : storage.getItem(key),
            setItem: (key, value) => { values.set(key, value); },
            removeItem: (key) => { values.set(key, null); },
          };
          restore(projected, result.client, { hosts: scopes.hosts, preferences: scopes.preferences });
          alreadyApplied = stableString(capture(projected, pending.scopes)) === current;
        }
        if (current !== pending.before && !alreadyApplied) pending = { ...pending, phase: "skipped", backupDirectory: result.backupDirectory, message: "복원 도중 앱 설정이 바뀌어 사용자 수정을 보존했습니다. 새 미리보기를 여세요." };
        else {
          if (!alreadyApplied) restore(storage, result.client, { hosts: scopes.hosts, preferences: scopes.preferences });
          pending = { ...pending, phase: "applied", backupDirectory: result.backupDirectory };
        }
      } catch (reason) { throw new Error(`서버 복원은 끝났으나 앱 설정 적용에 실패했습니다. 이어받기로 다시 확인하세요. 이전 서버 설정: ${result.backupDirectory}. ${reason instanceof Error ? reason.message : ""}`); }
    }
    memory.pending(host, pending);
  }
  // Persist the local phase before the release request. If its reply is lost,
  // retry only release; never replay the server restore or overwrite later edits.
  await calls.release(key);
  if (!active()) return null;
  memory.clearPending(host, input.previewId);
  if (pending.phase === "failed" || pending.phase === "skipped") throw new Error(`${pending.message}${pending.backupDirectory ? ` 이전 서버 설정: ${pending.backupDirectory}` : ""}`);
  return { backupDirectory: pending.backupDirectory! };
}
