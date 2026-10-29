import assert from "node:assert/strict";
import test from "node:test";
import { AutoClient } from "../client/automation";
import { capture, type StorageAdapter } from "../client/storage";
import { AutoSyncRpc } from "../server/auto-rpc";
import type { AutoSync } from "../server/automation";
import { offStatus } from "../shared/automation";

test("overlapping windows preserve a local edit made after the original restore request", async () => {
  const clientId = "26b0162d-1cd6-45d3-9a75-267f094a9e05";
  const ready = { ...offStatus, enabled: true, ownerClientId: clientId, state: "ready" as const };
  const values = new Map<string, string>([["@paseo:preferred-editor", "vscode"]]);
  const storage: StorageAdapter = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const gate = new AutoSyncRpc(async () => ready, 1000);
  type Result = Awaited<ReturnType<AutoSync["tick"]>>;
  let finish!: (value: Result) => void;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const operation = new Promise<Result>(resolve => { finish = resolve; });
  let calls = 0, acknowledgements = 0;
  const transport = {
    status: () => gate.status(), enable: async () => ready, disable: async () => offStatus,
    tick: () => gate.tick(clientId, () => { calls++; started(); return operation; }),
    acknowledge: async () => { acknowledgements++; return ready; },
  };
  const first = new AutoClient(transport, () => storage, null, clientId);
  const second = new AutoClient(transport, () => storage, null, clientId);
  try {
    const initial = first.synchronize();
    await beginning;
    values.set("@paseo:preferred-editor", "cursor");
    const following = second.synchronize();
    await new Promise(resolve => setImmediate(resolve));
    finish({ status: ready, operation: { id: "restore", client: { hosts: [], preferences: { "@paseo:preferred-editor": "remote-editor" } }, scopes: ready.scopes } });
    await Promise.all([initial, following]);
    assert.equal(capture(storage).preferences["@paseo:preferred-editor"], "cursor");
    assert.equal(acknowledgements, 0);
    assert.equal(calls, 1);
    assert.equal(first.getSnapshot().status.state, "error");
  } finally { first.dispose(); second.dispose(); }
});
