import assert from "node:assert/strict";
import { test } from "node:test";
import { providerFamily, readClaudeActivity, runningClaudeAgents, type AgentActivity, type AgentReader } from "./claude-activity";

const providers = {
  "claude-account": { extends: "claude" },
  "claude-nested": { extends: "claude-account" },
  "codex-account": { extends: "codex" },
  loop: { extends: "loop-back" },
  "loop-back": { extends: "loop" },
};
const agent = (provider: string, status: string, activeTurn: unknown = null): AgentActivity => ({ provider, status, activeTurn });

test("상속한 프로바이더도 원래 CLI 계열로 판정하고 순환 설정에서 멈춘다", () => {
  assert.equal(providerFamily("claude", providers), "claude");
  assert.equal(providerFamily("claude-nested", providers), "claude");
  assert.equal(providerFamily("codex-account", providers), "codex");
  assert.equal(typeof providerFamily("loop", providers), "string");
});

test("진행 중이거나 시작 중인 Claude 계열 에이전트만 센다", () => {
  const agents = [
    agent("claude", "running"),
    agent("claude-account", "initializing"),
    agent("claude-nested", "idle", { turnId: "t", startedAt: null }),
    agent("claude-account", "idle"),
    agent("claude", "closed"),
    agent("claude", "error"),
    agent("codex", "running"),
    agent("codex-account", "running"),
  ];
  assert.equal(runningClaudeAgents(agents, providers), 3);
  assert.equal(runningClaudeAgents([], providers), 0);
});

const reader = (list: AgentReader["agents"]["list"]): AgentReader => ({
  agents: { list },
  config: { get: async () => ({ config: { providers } }) },
});

test("데몬의 에이전트 목록에서 실행 중인 Claude 작업 수를 읽는다", async () => {
  let asked: Parameters<AgentReader["agents"]["list"]>[0] | undefined;
  const result = await readClaudeActivity(
    reader(async (options) => {
      asked = options;
      return { entries: [{ agent: agent("claude-account", "running") }, { agent: agent("codex", "running") }] };
    }),
  );
  assert.deepEqual(result, { claudeRunning: 1 });
  // Background helpers spend the same login, and only live turns are asked for.
  assert.equal(asked?.includeBackground, true);
  assert.deepEqual(asked?.filter?.statuses, ["initializing", "running"]);
});

test("백그라운드 목록을 모르는 데몬에서는 나머지 에이전트로 센다", async () => {
  const result = await readClaudeActivity(
    reader(async (options) => {
      if (options.includeBackground) throw new Error("Update the host to use background workspaces.");
      return { entries: [{ agent: agent("claude", "running") }, { agent: agent("claude", "running") }] };
    }),
  );
  assert.deepEqual(result, { claudeRunning: 2 });
});

test("목록을 읽지 못하거나 늦으면 아무것도 보고하지 않는다", async (t) => {
  assert.deepEqual(await readClaudeActivity(reader(async () => { throw new Error("daemon"); })), {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = readClaudeActivity(reader(() => new Promise(() => {})));
  t.mock.timers.tick(5_000);
  assert.deepEqual(await pending, {});
});
