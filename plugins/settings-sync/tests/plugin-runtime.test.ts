import assert from "node:assert/strict";
import test from "node:test";
import { verifyPlugins } from "../server/plugin-runtime";

test("newly configured plugins can report failed without an error while starting", async () => {
  let reads = 0;
  await verifyPlugins("unused", [{ id: "new-plugin", path: "/restored" }], async () => {
    reads++;
    return [{ id: "new-plugin", path: "/restored", status: reads < 3 ? "failed" : "running" }];
  });
  assert.equal(reads, 3);
});

test("a recorded build failure aborts restoration immediately", async () => {
  let reads = 0;
  await assert.rejects(verifyPlugins("unused", [{ id: "broken", path: "/restored" }], async () => {
    reads++;
    return [{ id: "broken", path: "/restored", status: "failed", error: "Build failed" }];
  }), /실행에 실패했습니다: broken/);
  assert.equal(reads, 1);
});

test("restored plugins are explicitly reloaded before checking their runtime", async () => {
  const events: string[] = [];
  await verifyPlugins("target-home", [{ id: "new-plugin", path: "/restored" }], async () => {
    events.push("read");
    return [{ id: "new-plugin", path: "/restored", status: "running" }];
  }, async (home, id) => {
    assert.equal(home, "target-home");
    events.push(`reload:${id}`);
  });
  assert.deepEqual(events, ["reload:new-plugin", "read"]);
});

test("reload errors abort without reporting a cached runtime as restored", async () => {
  await assert.rejects(verifyPlugins("unused", [{ id: "broken", path: "/restored" }], async () => {
    assert.fail("cached runtime must not be checked after a failed reload");
  }, async () => { throw Error("reload failed"); }), /reload failed/);
});
