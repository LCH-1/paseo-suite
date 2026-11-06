import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { hiddenAliasPatch, keepAliasesHidden } from "./hidden-aliases";

const providers = {
  claude: { enabled: true, selectable: true },
  codex: { enabled: true },
  "claude-second": { extends: "claude", enabled: true },
  "claude-hidden": { extends: "claude", enabled: true, selectable: false },
  "claude-off": { extends: "claude", enabled: false },
  "codex-second": { extends: "codex", enabled: true, selectable: true },
  cursor: { extends: "acp" },
  acp: { enabled: false },
};

test("보이는 Claude·Codex 별칭만 숨기고 본 항목과 다른 계열은 그대로 둔다", () => {
  assert.deepEqual(hiddenAliasPatch(providers), {
    "claude-second": { selectable: false },
    "codex-second": { selectable: false },
  });
  assert.deepEqual(hiddenAliasPatch({ claude: {}, codex: {} }), {});
});

function connection(calls: { patched: unknown[]; closed: number }, config = providers) {
  return {
    async connect() {},
    close() {
      calls.closed++;
    },
    async getDaemonConfig() {
      return { config: { providers: config } };
    },
    async patchDaemonConfig(patch: unknown) {
      calls.patched.push(patch);
      return { config: {} };
    },
  } as never;
}

test("데몬이 아직 연결을 받지 않으면 다시 시도해 숨긴다", async () => {
  const calls = { patched: [] as unknown[], closed: 0 };
  let attempts = 0;
  const stop = keepAliasesHidden("home", {
    retryMs: 1,
    create: async () => {
      if (++attempts < 3) throw Error("connection refused");
      return connection(calls);
    },
  });
  await delay(50);
  stop();
  assert.equal(attempts, 3);
  assert.deepEqual(calls.patched, [
    { providers: { "claude-second": { selectable: false }, "codex-second": { selectable: false } } },
  ]);
  assert.equal(calls.closed, 1);
});

test("이미 숨겨져 있으면 설정을 쓰지 않고, 해제 후에는 재시도하지 않는다", async () => {
  const calls = { patched: [] as unknown[], closed: 0 };
  const stop = keepAliasesHidden("home", {
    create: async () => connection(calls, { claude: {}, codex: {} } as never),
  });
  await delay(10);
  stop();
  assert.deepEqual(calls.patched, []);
  let attempts = 0;
  const stopped = keepAliasesHidden("home", {
    retryMs: 1,
    create: async () => {
      attempts++;
      throw Error("refused");
    },
  });
  stopped();
  await delay(20);
  assert.equal(attempts, 1);
});
