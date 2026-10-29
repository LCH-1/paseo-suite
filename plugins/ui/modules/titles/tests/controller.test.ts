import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { z } from "zod";
import { TitleSyncController } from "../client/controller";
import type { AgentTabTitleCapability, TitleSyncClient } from "../client/sdk-extension";
import { settings, settingsMethods } from "../shared/settings";
import { FakeWorkspaceApi, page, workspace, type WorkspacePage } from "./workspace-fixture";

type Observation = ReturnType<TitleSyncClient["paseo"]["observeEvents"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type ReadResult = z.output<typeof settingsMethods.read.output>;
type WriteResult = z.output<typeof settingsMethods.write.output>;
type WriteInput = z.output<typeof settingsMethods.write.input>;
type Contribution = Parameters<AgentTabTitleCapability["addAgentTabTitleResolver"]>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function ready(enabled: boolean, revision = "r1"): ReadResult {
  return { status: "ready", revision, values: { schemaVersion: 1, enabled } };
}

class FakeObservation implements Observation {
  readonly subscriptionId = "subscription-1";
  readonly readyResult = deferred<Snapshot>();
  readonly ready = this.readyResult.promise;
  private observer: Observer | null = null;
  private disposed = false;

  constructor(private readonly host: FakeHost) {}

  subscribe(observer: Observer): () => void {
    this.host.subscribeCount++;
    this.observer = observer;
    return () => { this.host.unsubscribeCount++; this.observer = null; };
  }

  release = async (): Promise<void> => {
    if (this.disposed) return;
    this.disposed = true;
    this.observer = null;
    this.host.releaseCount++;
  };

  changed(settingsId: string): void {
    if (this.disposed) return;
    this.observer?.update({
      type: "status",
      payload: { status: "plugin_settings_changed", pluginId: "sidebar-title-sync", settingsId },
    });
  }

  snapshot(): void {
    if (this.disposed) return;
    const value: Snapshot = { requestId: "request-1", subscriptionId: "subscription-1" };
    this.observer?.snapshot(value);
    this.readyResult.resolve(value);
  }

  fail(error: Error): void {
    if (this.disposed) return;
    this.readyResult.reject(error);
    this.observer?.error?.(error);
    void this.release();
  }
}

class FakeHost {
  readonly workspaceHost = new FakeWorkspaceApi();
  current: ReadResult = { status: "ready", revision: "r1", values: {} };
  readCount = 0;
  observeCount = 0;
  subscribeCount = 0;
  unsubscribeCount = 0;
  releaseCount = 0;
  readonly readQueue: Array<() => Promise<ReadResult>> = [];
  readonly writes: WriteInput[] = [];
  readonly registrations: Array<{ contribution: Contribution; invalidations: number; removals: number }> = [];
  writeResponse: ((input: WriteInput) => Promise<WriteResult>) | null = null;
  readonly observations: FakeObservation[] = [];

  get observation(): FakeObservation {
    const current = this.observations.at(-1);
    assert.ok(current, "The controller must create an observation before it can receive events");
    return current;
  }

  client(supported = true): TitleSyncClient {
    const observeEvents: TitleSyncClient["paseo"]["observeEvents"] = (events) => {
      this.observeCount++;
      assert.deepEqual(events, ["status.plugin_settings_changed"]);
      const observation = new FakeObservation(this);
      this.observations.push(observation);
      return observation;
    };
    const rpc: TitleSyncClient["rpc"] = async (contract, input) => {
      let result: ReadResult | WriteResult;
      if (contract.name === settingsMethods.read.name) {
        assert.deepEqual(input, {});
        this.readCount++;
        result = await (this.readQueue.shift()?.() ?? Promise.resolve(this.current));
      } else if (contract.name === settingsMethods.write.name) {
        const parsed = settingsMethods.write.input.parse(input);
        this.writes.push(parsed);
        if (this.writeResponse) result = await this.writeResponse(parsed);
        else {
          this.current = { status: "ready", revision: `r${this.writes.length + 1}`, values: parsed.values };
          result = { ...this.current, status: "saved" };
        }
      } else throw new Error(`Unexpected RPC: ${contract.name}`);
      return contract.output.parse(result);
    };
    const paseo = { observeEvents, workspaces: this.workspaceHost.api } as TitleSyncClient["paseo"];
    const client: TitleSyncClient = { paseo, rpc };
    if (supported) client.addAgentTabTitleResolver = (contribution) => {
      const record = { contribution, invalidations: 0, removals: 0 };
      this.registrations.push(record);
      return {
        invalidate: () => { record.invalidations++; },
        remove: () => { record.removals++; },
      };
    };
    return client;
  }

  changed(settingsId = settings.id): void {
    this.observation.changed(settingsId);
  }

  snapshot(): void {
    this.observation.snapshot();
  }
}

async function flush(): Promise<void> {
  await setImmediate();
}

test("loads the enabled default before registering and releases one registration on repeated stop", async () => {
  const host = new FakeHost();
  const firstRead = deferred<ReadResult>();
  host.readQueue.push(() => firstRead.promise);
  const controller = new TitleSyncController(host.client());
  let notifications = 0;
  controller.subscribe(() => { notifications++; });
  assert.equal(controller.getSnapshot().status, "loading");
  controller.start();
  controller.start();
  assert.equal(host.registrations.length, 0);
  assert.equal(host.observeCount, 1);
  assert.equal(host.subscribeCount, 1);
  firstRead.resolve(host.current);
  await flush();
  assert.deepEqual(controller.getSnapshot(), {
    supported: true, status: "ready", enabled: true, saving: false, error: null,
  });
  assert.equal(host.registrations.length, 1);
  assert.equal(host.registrations[0].contribution.id, "sidebar-title");
  assert.ok(notifications > 0);
  controller.stop();
  controller.stop();
  controller.start();
  assert.equal(host.registrations[0].removals, 1);
  assert.equal(host.unsubscribeCount, 1);
  assert.equal(host.releaseCount, 1);
  assert.equal(host.observeCount, 1);
  const previousNotifications = notifications;
  await controller.reload();
  assert.equal(notifications, previousNotifications);
});

test("starts disabled and persists toggles using the read revision, then re-reads authoritative values", async () => {
  const host = new FakeHost();
  host.current = ready(false, "first-revision");
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  assert.equal(host.registrations.length, 0);
  await controller.setEnabled(true);
  assert.deepEqual(host.writes, [{ revision: "first-revision", values: { schemaVersion: 1, enabled: true } }]);
  assert.equal(host.readCount, 2);
  assert.equal(controller.getSnapshot().enabled, true);
  assert.equal(controller.getSnapshot().saving, false);
  assert.equal(host.registrations.length, 1);
  await controller.setEnabled(false);
  assert.equal(host.writes[1].revision, "r2");
  assert.equal(host.registrations[0].removals, 1);
  assert.equal(controller.getSnapshot().enabled, false);
  await controller.setEnabled(false);
  assert.equal(host.writes.length, 2);
  controller.stop();
});

test("settings notifications and reconnect snapshots refresh without polling or redundant registrations", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  assert.equal(host.readCount, 1);
  const initialInvalidations = host.registrations[0].invalidations;
  host.changed("another-settings-definition");
  await flush();
  assert.equal(host.readCount, 1);
  host.changed();
  await flush();
  assert.equal(host.readCount, 2);
  assert.equal(host.registrations.length, 1);
  assert.equal(host.registrations[0].invalidations, initialInvalidations + 1);
  host.current = ready(false, "remote-change");
  host.snapshot();
  await flush();
  assert.equal(host.readCount, 3);
  assert.equal(controller.getSnapshot().enabled, false);
  assert.equal(host.registrations[0].removals, 1);
  await flush();
  assert.equal(host.readCount, 3);
  assert.equal(host.writes.length, 0);
  controller.stop();
});

test("a late settings response after stop cannot register, notify or revive a resolver", async () => {
  const host = new FakeHost();
  const read = deferred<ReadResult>();
  host.readQueue.push(() => read.promise);
  const controller = new TitleSyncController(host.client());
  let notifications = 0;
  controller.subscribe(() => { notifications++; });
  controller.start();
  controller.stop();
  read.resolve(ready(true));
  await flush();
  assert.equal(host.registrations.length, 0);
  assert.equal(notifications, 0);
  assert.equal(host.releaseCount, 1);
  await controller.setEnabled(true);
  assert.equal(host.writes.length, 0);
});

test("a read already in progress at save cannot become the final stale state", async () => {
  const host = new FakeHost();
  host.current = ready(false);
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  const stale = deferred<ReadResult>();
  host.readQueue.push(() => stale.promise);
  const reloading = controller.reload();
  const saving = controller.setEnabled(true);
  await flush();
  assert.equal(controller.getSnapshot().saving, true);
  stale.resolve(ready(false, "old-revision"));
  await Promise.all([reloading, saving]);
  assert.equal(host.readCount, 3);
  assert.equal(controller.getSnapshot().enabled, true);
  assert.equal(controller.getSnapshot().saving, false);
  assert.equal(host.registrations.length, 1);
  controller.stop();
});

test("coalesces concurrent refreshes and prevents concurrent writes", async () => {
  const host = new FakeHost();
  host.current = ready(false);
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  const saving = deferred<WriteResult>();
  host.writeResponse = () => saving.promise;
  const first = controller.setEnabled(true);
  await controller.setEnabled(true);
  assert.equal(host.writes.length, 1);
  host.current = ready(true, "saved-revision");
  saving.resolve({ status: "saved", revision: "saved-revision", values: { schemaVersion: 1, enabled: true } });
  await first;
  const read = deferred<ReadResult>();
  host.readQueue.push(() => read.promise);
  const a = controller.reload();
  const b = controller.reload();
  const c = controller.reload();
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  read.resolve(host.current);
  await a;
  assert.equal(host.readCount, 4);
  controller.stop();
});

test("a refresh queued between the read drain and finalization is awaited rather than lost", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  let trailingRefresh: Promise<void> | undefined;
  controller.subscribe(() => {
    if (host.readCount === 2) queueMicrotask(() => {
      host.current = ready(false, "latest-revision");
      trailingRefresh = controller.reload();
    });
  });
  await controller.reload();
  assert.ok(trailingRefresh);
  assert.equal(host.readCount, 3);
  assert.equal(controller.getSnapshot().enabled, false);
  assert.equal(host.registrations[0].removals, 1);
  await trailingRefresh;
  assert.equal(host.readCount, 3);
  controller.stop();
});

test("read failures and invalid settings stay inactive and recover through a later refresh", async () => {
  const host = new FakeHost();
  host.readQueue.push(async () => { throw new Error("offline"); });
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  assert.equal(controller.getSnapshot().status, "error");
  assert.equal(controller.getSnapshot().error, "offline");
  assert.equal(host.registrations.length, 0);
  await controller.setEnabled(true);
  assert.equal(host.writes.length, 0);
  host.current = { status: "invalid", revision: "invalid-revision", error: "invalid stored settings" };
  await controller.reload();
  assert.equal(controller.getSnapshot().error, "invalid stored settings");
  host.current = { status: "ready", revision: "invalid-values", values: { enabled: "yes" } };
  await controller.reload();
  assert.equal(controller.getSnapshot().status, "error");
  assert.equal(host.registrations.length, 0);
  host.current = ready(true, "recovered");
  await controller.reload();
  assert.equal(controller.getSnapshot().status, "ready");
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(host.registrations.length, 1);
  controller.stop();
});

test("write conflicts re-read current host state, expose the error and use the fresh revision next time", async () => {
  const host = new FakeHost();
  host.current = ready(false);
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  host.writeResponse = async () => {
    host.current = ready(false, "remote-revision");
    return { status: "conflict", error: "Settings changed elsewhere" };
  };
  await controller.setEnabled(true);
  assert.equal(controller.getSnapshot().enabled, false);
  assert.equal(controller.getSnapshot().error, "Settings changed elsewhere");
  assert.equal(controller.getSnapshot().saving, false);
  assert.equal(host.registrations.length, 0);
  host.writeResponse = null;
  await controller.setEnabled(true);
  assert.equal(host.writes[1].revision, "remote-revision");
  assert.equal(controller.getSnapshot().enabled, true);
  assert.equal(controller.getSnapshot().error, null);
  controller.stop();
});

test("a failed settings write keeps the original enabled display and reports the failure", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  host.writeResponse = async () => { throw new Error("connection lost during save"); };
  await controller.setEnabled(false);
  assert.equal(controller.getSnapshot().enabled, true);
  assert.equal(controller.getSnapshot().saving, false);
  assert.equal(controller.getSnapshot().error, "connection lost during save");
  assert.equal(host.registrations.length, 1);
  assert.equal(host.registrations[0].removals, 0);
  assert.equal(host.readCount, 2);
  controller.stop();
});

test("stop during a save releases the existing resolver and ignores the eventual write response", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  const write = deferred<WriteResult>();
  host.writeResponse = () => write.promise;
  const saving = controller.setEnabled(false);
  controller.stop();
  const snapshotAtStop = controller.getSnapshot();
  write.resolve({ status: "saved", revision: "r2", values: { schemaVersion: 1, enabled: false } });
  await saving;
  assert.strictEqual(controller.getSnapshot(), snapshotAtStop);
  assert.equal(host.readCount, 1);
  assert.equal(host.registrations.length, 1);
  assert.equal(host.registrations[0].removals, 1);
  assert.equal(host.releaseCount, 1);
});

test("replaces an observation whose initial ready promise rejected and resumes settings event updates", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  const failed = host.observation;
  failed.readyResult.reject(new Error("event subscription disconnected"));
  await failed.release();
  await flush();
  assert.equal(controller.getSnapshot().error, "event subscription disconnected");
  assert.equal(host.registrations.length, 1);
  const readsAfterFailure = host.readCount;
  failed.snapshot();
  failed.changed(settings.id);
  await flush();
  assert.equal(host.readCount, readsAfterFailure);
  await controller.reload();
  assert.equal(host.observeCount, 2);
  assert.notStrictEqual(host.observation, failed);
  host.snapshot();
  await flush();
  assert.equal(controller.getSnapshot().error, null);
  host.current = ready(false, "new-observation-update");
  host.changed();
  await flush();
  assert.equal(controller.getSnapshot().enabled, false);
  assert.equal(host.registrations[0].removals, 1);
  controller.stop();
});

test("a reconnect bootstrap error after initial readiness is visible and can restore observation", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  host.snapshot();
  await flush();
  host.observation.fail(new Error("reconnect subscription failed"));
  await flush();
  assert.equal(controller.getSnapshot().error, "reconnect subscription failed");
  await controller.reload();
  assert.equal(host.observeCount, 2);
  host.snapshot();
  await flush();
  assert.equal(controller.getSnapshot().error, null);
  host.current = ready(false, "after-reconnect");
  host.changed();
  await flush();
  assert.equal(controller.getSnapshot().enabled, false);
  controller.stop();
});

test("late ready rejection from a replaced observation cannot dispose the new observation", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  host.observation.fail(new Error("first bootstrap failed"));
  await controller.reload();
  assert.equal(host.observeCount, 2);
  host.snapshot();
  await flush();
  assert.equal(host.observeCount, 2);
  assert.equal(controller.getSnapshot().error, null);
  host.current = ready(false, "new-live-observation");
  host.changed();
  await flush();
  assert.equal(controller.getSnapshot().enabled, false);
  controller.stop();
});

test("an unsupported host never registers a title resolver or writes settings", async () => {
  const host = new FakeHost();
  const controller = new TitleSyncController(host.client(false));
  controller.start();
  await flush();
  assert.equal(controller.getSnapshot().supported, false);
  await controller.setEnabled(false);
  host.current = ready(false, "remote-revision");
  host.changed();
  await flush();
  assert.equal(host.registrations.length, 0);
  assert.equal(host.writes.length, 0);
  assert.equal(host.workspaceHost.calls.length, 0);
  controller.stop();
});

test("project metadata arrival and rename invalidate a synchronous prefix resolver, while disabling releases metadata", async () => {
  const host = new FakeHost();
  const initialMetadata = deferred<WorkspacePage>();
  host.workspaceHost.firstRead = () => initialMetadata.promise;
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  const context = { serverId: "host", workspaceId: "workspace-1", agentId: "agent-1",
    defaultLabel: "[Image #1] 지금 작업해줘", sidebarLabel: "main" };
  const registration = host.registrations[0];
  assert.equal(registration.contribution.resolve(context), "main");
  initialMetadata.resolve(page());
  await flush();
  assert.equal(registration.contribution.resolve(context), "cursor-setting-sync-main");
  assert.equal(registration.invalidations, 1);
  for (let index = 0; index < 20; index++) registration.contribution.resolve(context);
  assert.equal(host.workspaceHost.calls.length, 1);
  host.workspaceHost.subscriptions[0].upsert(workspace("workspace-1", "changed-project"));
  assert.equal(registration.contribution.resolve(context), "changed-project-main");
  assert.equal(registration.invalidations, 2);
  assert.equal(context.defaultLabel, "[Image #1] 지금 작업해줘");
  await controller.setEnabled(false);
  assert.equal(registration.removals, 1);
  assert.equal(host.workspaceHost.subscriptions[0].releases, 1);
  host.workspaceHost.subscriptions[0].upsert(workspace("workspace-1", "late-project"));
  assert.equal(registration.invalidations, 2);
  controller.stop();
  assert.equal(host.workspaceHost.subscriptions[0].releases, 1);
});

test("modern app project labels remain correct when the compatibility metadata cache is unavailable", async () => {
  const host = new FakeHost();
  host.workspaceHost.firstRead = async () => { throw new Error("workspace metadata temporarily offline"); };
  const controller = new TitleSyncController(host.client());
  controller.start();
  await flush();
  const registration = host.registrations[0];
  const context = { serverId: "host", workspaceId: "workspace-1", agentId: "agent-1",
    defaultLabel: "[Image #1] 원본", sidebarLabel: "main", projectLabel: "app-project" };
  const callsBeforeResolve = host.workspaceHost.calls.length;
  for (let index = 0; index < 20; index++) assert.deepEqual(registration.contribution.resolve(context), {
    primaryLabel: "app-project", secondaryLabel: "main",
  });
  assert.equal(host.workspaceHost.calls.length, callsBeforeResolve);
  assert.equal(context.defaultLabel, "[Image #1] 원본");
  controller.stop();
});

test("two host installations keep their settings, revisions and resolver lifetimes independent", async () => {
  const firstHost = new FakeHost();
  const secondHost = new FakeHost();
  firstHost.current = ready(true, "first-host-revision");
  secondHost.current = ready(false, "second-host-revision");
  const first = new TitleSyncController(firstHost.client());
  const second = new TitleSyncController(secondHost.client());
  first.start();
  second.start();
  await flush();
  assert.equal(firstHost.registrations.length, 1);
  assert.equal(secondHost.registrations.length, 0);
  await second.setEnabled(true);
  assert.equal(secondHost.writes[0].revision, "second-host-revision");
  assert.equal(firstHost.writes.length, 0);
  first.stop();
  assert.equal(firstHost.registrations[0].removals, 1);
  assert.equal(secondHost.registrations[0].removals, 0);
  assert.equal(second.getSnapshot().enabled, true);
  second.stop();
});
