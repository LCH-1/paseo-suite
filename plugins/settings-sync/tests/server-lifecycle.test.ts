import assert from "node:assert/strict";
import test from "node:test";
import { SyncService } from "../server/service";
import { GitHubLogin } from "../server/login";
import type { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Snapshot } from "../shared/model";
import { decrypt } from "../server/crypto";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("cleanup waits for a real in-flight encrypted upload and rejects queued and later work", async (t) => {
  const entered = gate(), release = gate();
  const events: string[] = [];
  let raw: string | null = null, sha: string | null = null;
  const scopes = { hosts: false, preferences: true, providers: false, config: false, plugins: false };
  const environment = { capture: async () => {
    entered.resolve(); await release.promise;
    return { version: 1, createdAt: "2026-10-28T00:00:00.000Z", device: "synthetic", client: { hosts: [], preferences: { "@paseo:preferred-editor": "synthetic-editor" } }, plugins: [], config: {}, scopes } satisfies Snapshot;
  } } as unknown as Environment;
  const vault = {
    verify: async () => "synthetic-account", read: async () => ({ raw, sha }),
    write: async (next: string) => { events.push("uploaded"); raw = next; return sha = "synthetic-revision"; },
  } as unknown as GitHubVault;
  const service = new SyncService(environment, () => vault, new GitHubLogin(async () => "synthetic-token", async () => "synthetic-account"));
  const connection = await service.connect({ flowId: (await service.start()).flowId, password: "synthetic lifecycle password" });
  const api = {} as PluginHandlerContext["paseo"];
  const running = service.serial(() => service.push(connection.sessionId, { hosts: [], preferences: {} }, api, scopes));
  await entered.promise;
  let queuedRan = false;
  const queued = service.serial(async () => { queuedRan = true; });
  const closing = Promise.resolve(service.dispose()).then(() => { events.push("disposed"); });
  // Attach rejection observers before releasing the queued microtasks.
  const queueResult = queued.then(() => "ran", () => "stopped");
  t.after(async () => { release.resolve(); await Promise.allSettled([running, queued, closing]); await service.dispose(); });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(events, [], "cleanup must not finish before the active upload");
  await assert.rejects(service.serial(async () => { throw Error("must not run"); }), /종료/);
  release.resolve();
  await running; await closing;
  assert.deepEqual(events, ["uploaded", "disposed"]);
  assert.equal(await queueResult, "stopped");
  assert.equal(queuedRan, false);
  const saved = await vault.read();
  assert.equal(typeof saved.raw, "string");
  assert.equal((await decrypt(saved.raw!, "synthetic lifecycle password")).client.preferences["@paseo:preferred-editor"], "synthetic-editor");
  assert.equal(await service.resume(connection.sessionId), null);
});

test("a failing active job still drains cleanup once and cannot run queued mutations", async () => {
  const entered = gate(), release = gate();
  const service = new SyncService();
  let queued = 0;
  const current = service.serial(async () => { entered.resolve(); await release.promise; throw Error("synthetic failure"); });
  await entered.promise;
  const waiting = service.serial(async () => { queued++; });
  const observed = Promise.allSettled([current, waiting]);
  const first = service.dispose(), second = service.dispose();
  release.resolve();
  await Promise.all([first, second]);
  const results = await observed;
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.equal(queued, 0);
});
