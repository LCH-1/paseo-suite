import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ProjectTitleCache } from "../client/project-title-cache";
import { FakeWorkspaceApi, page, workspace, type WorkspacePage } from "./workspace-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test("uses official custom/display names and invalidates after the initial metadata snapshot", async () => {
  const host = new FakeWorkspaceApi();
  host.first = page([workspace("a", "repo", "사용자 프로젝트"), workspace("b", "공식 표시 이름")]);
  let invalidations = 0;
  const cache = new ProjectTitleCache(host.api, () => { invalidations++; });
  assert.equal(cache.get("a"), null);
  cache.start();
  cache.start();
  await setImmediate();
  assert.equal(host.calls.length, 1);
  assert.deepEqual(host.calls[0], { subscribe: {}, page: { limit: 200 }, includeBackground: true });
  assert.equal(cache.get("a"), "사용자 프로젝트");
  assert.equal(cache.get("b"), "공식 표시 이름");
  assert.equal(cache.get("unknown"), null);
  assert.equal(invalidations, 1);
  cache.stop();
  cache.stop();
  assert.equal(host.subscriptions[0].releases, 1);
  assert.equal(host.subscriptions[0].unsubscribes, 1);
});

test("reads every page and replays project rename/workspace removals received during pagination", async () => {
  const host = new FakeWorkspaceApi();
  const tail = deferred<WorkspacePage>();
  host.first = page([workspace("a", "old-project"), workspace("gone", "removed-project")], "page-2");
  host.pages.set("page-2", () => tail.promise);
  const cache = new ProjectTitleCache(host.api, () => {});
  cache.start();
  await setImmediate();
  host.subscriptions[0].upsert(workspace("a", "renamed-project"));
  host.subscriptions[0].remove("gone");
  tail.resolve(page([workspace("a", "stale-page-name"), workspace("b", "last-page-project")]));
  await setImmediate();
  assert.equal(cache.get("a"), "renamed-project");
  assert.equal(cache.get("b"), "last-page-project");
  assert.equal(cache.get("gone"), null);
  assert.deepEqual(host.calls[1], { page: { limit: 200, cursor: "page-2" }, includeBackground: true });
  cache.stop();
});

test("applies live project renames carried by workspace upserts without reading or writing titles", async () => {
  const host = new FakeWorkspaceApi();
  let invalidations = 0;
  const cache = new ProjectTitleCache(host.api, () => { invalidations++; });
  cache.start();
  await setImmediate();
  host.subscriptions[0].upsert(workspace("workspace-1", "renamed"));
  assert.equal(cache.get("workspace-1"), "renamed");
  host.subscriptions[0].remove("workspace-1");
  assert.equal(cache.get("workspace-1"), null);
  assert.equal(host.calls.length, 1);
  assert.equal(invalidations, 3);
  cache.stop();
});

test("unchanged project names and unknown removals do not invalidate visible tab titles", async () => {
  const host = new FakeWorkspaceApi();
  let invalidations = 0;
  const cache = new ProjectTitleCache(host.api, () => { invalidations++; });
  cache.start();
  await setImmediate();
  assert.equal(invalidations, 1);
  for (let index = 0; index < 100; index++) host.subscriptions[0].upsert(workspace());
  host.subscriptions[0].remove("unknown");
  assert.equal(invalidations, 1);
  assert.equal(cache.get("workspace-1"), "cursor-setting-sync");
  host.subscriptions[0].upsert(workspace("workspace-1", "renamed"));
  assert.equal(invalidations, 2);
  assert.equal(cache.get("workspace-1"), "renamed");
  host.subscriptions[0].upsert(workspace("workspace-1", "renamed"));
  host.subscriptions[0].remove("workspace-1");
  host.subscriptions[0].remove("workspace-1");
  assert.equal(invalidations, 3);
  assert.equal(cache.get("workspace-1"), null);
  cache.stop();
});

test("reconnect snapshots replace cached metadata using the same single subscription", async () => {
  const host = new FakeWorkspaceApi();
  let invalidations = 0;
  const cache = new ProjectTitleCache(host.api, () => { invalidations++; });
  cache.start();
  await setImmediate();
  host.subscriptions[0].snapshot(page([workspace("new", "renamed-while-offline")]));
  await setImmediate();
  assert.equal(cache.get("workspace-1"), null);
  assert.equal(cache.get("new"), "renamed-while-offline");
  assert.equal(host.calls.length, 1);
  assert.equal(invalidations, 2);
  cache.stop();
});

test("unchanged reconnect snapshots preserve visible titles while renames and removals still invalidate", async () => {
  const host = new FakeWorkspaceApi();
  host.first = page([workspace("a", "Project A"), workspace("b", "Project B")]);
  let invalidations = 0;
  const cache = new ProjectTitleCache(host.api, () => { invalidations++; });
  cache.start();
  await setImmediate();
  assert.equal(invalidations, 1);
  host.subscriptions[0].snapshot(page([workspace("b", "Project B"), workspace("a", "Project A")]));
  await setImmediate();
  assert.equal(invalidations, 1);
  assert.equal(cache.get("a"), "Project A");
  host.subscriptions[0].snapshot(page([workspace("b", "Project B"), workspace("a", "Renamed A")]));
  await setImmediate();
  assert.equal(invalidations, 2);
  assert.equal(cache.get("a"), "Renamed A");
  host.subscriptions[0].snapshot(page([workspace("b", "Project B")]));
  await setImmediate();
  assert.equal(invalidations, 3);
  assert.equal(cache.get("a"), null);
  host.subscriptions[0].snapshot(page([workspace("b", "Project B")]));
  await setImmediate();
  assert.equal(invalidations, 3);
  cache.stop();
});

test("a superseded paginated snapshot cannot overwrite a newer reconnect snapshot", async () => {
  const host = new FakeWorkspaceApi();
  const oldTail = deferred<WorkspacePage>();
  host.first = page([workspace("old", "old")], "old-tail");
  host.pages.set("old-tail", () => oldTail.promise);
  const cache = new ProjectTitleCache(host.api, () => {});
  cache.start();
  await setImmediate();
  host.subscriptions[0].snapshot(page([workspace("new", "current")]));
  oldTail.resolve(page([workspace("late", "stale")]));
  await setImmediate();
  assert.equal(cache.get("new"), "current");
  assert.equal(cache.get("old"), null);
  assert.equal(cache.get("late"), null);
  cache.stop();
});

test("stop ignores late pages, clears names and releases one observation", async () => {
  const host = new FakeWorkspaceApi();
  const tail = deferred<WorkspacePage>();
  host.first = page([workspace()], "tail");
  host.pages.set("tail", () => tail.promise);
  let invalidations = 0;
  const cache = new ProjectTitleCache(host.api, () => { invalidations++; });
  cache.start();
  await setImmediate();
  cache.stop();
  tail.resolve(page([workspace("late", "late")]));
  await setImmediate();
  assert.equal(invalidations, 0);
  assert.equal(cache.get("late"), null);
  assert.equal(host.subscriptions[0].releases, 1);
});

test("stop during bootstrap releases the late handle before an enabled restart opens another", async () => {
  const host = new FakeWorkspaceApi();
  const bootstrap = deferred<WorkspacePage>();
  host.firstRead = () => bootstrap.promise;
  const cache = new ProjectTitleCache(host.api, () => {});
  cache.start();
  cache.stop();
  cache.start();
  assert.equal(host.calls.length, 1);
  host.firstRead = null;
  bootstrap.resolve(page());
  await setImmediate();
  assert.equal(host.calls.length, 2);
  assert.equal(host.subscriptions[0].releases, 1);
  assert.equal(host.subscriptions[1].releases, 0);
  assert.equal(cache.get("workspace-1"), "cursor-setting-sync");
  cache.stop();
});

test("a failed observation can restart without duplicate retained subscriptions", async () => {
  const host = new FakeWorkspaceApi();
  const cache = new ProjectTitleCache(host.api, () => {});
  cache.start();
  await setImmediate();
  host.subscriptions[0].fail();
  cache.start();
  await setImmediate();
  assert.equal(host.calls.length, 2);
  assert.equal(host.subscriptions[0].releases, 1);
  assert.equal(host.subscriptions[1].releases, 0);
  cache.stop();
});

test("failed bootstrap and incomplete pagination preserve the previous cache until recovery", async () => {
  const host = new FakeWorkspaceApi();
  const cache = new ProjectTitleCache(host.api, () => {});
  host.firstRead = async () => { throw new Error("offline"); };
  cache.start();
  await setImmediate();
  assert.equal(cache.get("workspace-1"), null);
  host.firstRead = null;
  cache.start();
  await setImmediate();
  host.subscriptions[0].snapshot(page([workspace("partial", "partial")], "broken"));
  await setImmediate();
  assert.equal(cache.get("workspace-1"), "cursor-setting-sync");
  assert.equal(cache.get("partial"), null);
  cache.stop();
});

test("separate host caches distinguish identical workspace and project IDs", async () => {
  const firstHost = new FakeWorkspaceApi();
  const secondHost = new FakeWorkspaceApi();
  firstHost.first = page([workspace("same", "first-project")]);
  secondHost.first = page([workspace("same", "second-project")]);
  const first = new ProjectTitleCache(firstHost.api, () => {});
  const second = new ProjectTitleCache(secondHost.api, () => {});
  first.start();
  second.start();
  await setImmediate();
  assert.equal(first.get("same"), "first-project");
  assert.equal(second.get("same"), "second-project");
  first.stop();
  assert.equal(second.get("same"), "second-project");
  second.stop();
});

function retryClock() {
  const jobs: Array<{ callback: () => void; delay: number; active: boolean }> = [];
  return {
    jobs,
    schedule(callback: () => void, delay: number) {
      const job = { callback, delay, active: true };
      jobs.push(job);
      return () => { job.active = false; };
    },
    async next() {
      const job = jobs.find((job) => job.active);
      assert.ok(job, "A failed request must schedule one bounded retry");
      job.active = false;
      job.callback();
      await setImmediate();
    },
  };
}

test("initial failures retry with bounded backoff and a settings refresh can reset an exhausted budget", async () => {
  const host = new FakeWorkspaceApi();
  const clock = retryClock();
  host.firstRead = async () => { throw new Error("temporary metadata failure"); };
  const cache = new ProjectTitleCache(host.api, () => {}, clock.schedule);
  cache.start();
  await setImmediate();
  for (let index = 0; index < 3; index++) await clock.next();
  assert.equal(host.calls.length, 4);
  assert.ok(host.calls.every((call) => call?.includeBackground === true));
  assert.deepEqual(clock.jobs.map((job) => job.delay), [500, 1500, 4000]);
  assert.equal(clock.jobs.filter((job) => job.active).length, 0);
  host.firstRead = null;
  cache.start();
  await setImmediate();
  assert.equal(cache.get("workspace-1"), "cursor-setting-sync");
  assert.equal(host.calls.length, 5);
  assert.equal(clock.jobs.filter((job) => job.active).length, 0);
  cache.stop();
});

test("a later-page failure rereads the complete snapshot using the existing subscription", async () => {
  const host = new FakeWorkspaceApi();
  const clock = retryClock();
  host.first = page([workspace("a", "project-a")], "tail");
  let reads = 0;
  host.pages.set("tail", async () => {
    if (++reads === 1) throw new Error("page temporarily unavailable");
    return page([workspace("b", "project-b")]);
  });
  const cache = new ProjectTitleCache(host.api, () => {}, clock.schedule);
  cache.start();
  await setImmediate();
  assert.equal(cache.get("a"), null);
  await clock.next();
  assert.equal(cache.get("a"), "project-a");
  assert.equal(cache.get("b"), "project-b");
  assert.equal(host.subscriptions.length, 1);
  assert.equal(host.calls.filter((call) => call?.subscribe).length, 1);
  assert.equal(clock.jobs.filter((job) => job.active).length, 0);
  cache.stop();
});

test("live changes during the retry's first page cannot be replaced by an older response", async () => {
  const host = new FakeWorkspaceApi();
  const clock = retryClock();
  const refresh = deferred<WorkspacePage>();
  host.first = page([workspace("a", "old-project")], "broken");
  host.firstPageRead = () => refresh.promise;
  const cache = new ProjectTitleCache(host.api, () => {}, clock.schedule);
  cache.start();
  await setImmediate();
  await clock.next();
  host.subscriptions[0].upsert(workspace("a", "renamed-project"));
  refresh.resolve(page([workspace("a", "old-project"), workspace("b", "new-project")]));
  await setImmediate();
  assert.equal(cache.get("a"), "renamed-project");
  assert.equal(cache.get("b"), "new-project");
  cache.stop();
});

test("stop cancels error retries and a retained timer cannot revive the cache", async () => {
  const host = new FakeWorkspaceApi();
  const clock = retryClock();
  host.firstRead = async () => { throw new Error("offline"); };
  const cache = new ProjectTitleCache(host.api, () => {}, clock.schedule);
  cache.start();
  await setImmediate();
  cache.stop();
  assert.equal(clock.jobs[0].active, false);
  clock.jobs[0].callback();
  await setImmediate();
  assert.equal(host.calls.length, 1);
});

test("retry waits for the prior observation release and never opens duplicate subscriptions", async () => {
  const host = new FakeWorkspaceApi();
  const clock = retryClock();
  const release = deferred<void>();
  const cache = new ProjectTitleCache(host.api, () => {}, clock.schedule);
  cache.start();
  await setImmediate();
  const first = host.subscriptions[0];
  const originalRelease = first.release;
  first.release = async () => { await originalRelease(); await release.promise; };
  first.fail();
  await clock.next();
  cache.start();
  cache.start();
  assert.equal(host.calls.length, 1);
  release.resolve();
  await setImmediate();
  assert.equal(host.subscriptions.length, 2);
  assert.equal(first.releases, 1);
  assert.equal(host.subscriptions[1].releases, 0);
  cache.stop();
});

test("background metadata is included and only the explicit unsupported contract permits foreground fallback", async () => {
  const host = new FakeWorkspaceApi();
  host.backgroundSupported = false;
  const cache = new ProjectTitleCache(host.api, () => {});
  cache.start();
  await setImmediate();
  assert.equal(host.calls.length, 2);
  assert.equal(host.calls[0]?.includeBackground, true);
  assert.equal(host.calls[1]?.includeBackground, false);
  assert.equal(cache.get("workspace-1"), "cursor-setting-sync");
  assert.equal(host.subscriptions.length, 1);
  cache.stop();
});

test("a disabled bootstrap cannot issue a late foreground fallback request", async () => {
  const host = new FakeWorkspaceApi();
  const pending = deferred<WorkspacePage>();
  host.firstRead = () => pending.promise;
  const cache = new ProjectTitleCache(host.api, () => {});
  cache.start();
  cache.stop();
  pending.reject(new Error("Update the host to use background workspaces."));
  await setImmediate();
  assert.equal(host.calls.length, 1);
});
