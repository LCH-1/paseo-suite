import assert from "node:assert/strict";
import test from "node:test";
import {
  exactRuntimeModel,
  installRuntimeModelPresentation,
} from "../client/runtime-model.ts";

const agent = (
  model = "claude-fable-5",
  raw: unknown = "claude-fable-5-2",
  provider = "claude",
) => ({
  provider,
  model: "configured-other-model",
  runtimeInfo: { model, extra: { runtimeModel: raw }, sessionId: "unchanged" },
});

test("CLI가 명시한 세부 버전만 복구하고 설정·다른 실행 모델을 근거로 추측하지 않는다", () => {
  assert.equal(exactRuntimeModel(agent()), "claude-fable-5-2");
  assert.equal(
    exactRuntimeModel(
      agent(
        "claude-fable-5",
        "claude-fable-5-2-20261109[1m]",
        "claude-account",
      ),
    ),
    "claude-fable-5-2",
  );
  for (const a of [
    agent("claude-fable-5-1"),
    agent("claude-fable-5-2"),
    agent("claude-fable-5", null),
    agent("claude-fable-5", "bedrock/claude-fable-5-2"),
    agent("claude-fable-5", "claude-opus-5-5"),
    agent("claude-fable-5", "claude-fable-5-2", "codex"),
  ])
    assert.equal(exactRuntimeModel(a), null);
});

test("활성 호스트 기존 대화를 즉시 보완하고 후속 이벤트·재진입·해제·원본 보존을 처리한다", () => {
  const initial = agent();
  const remote = { agents: new Map([["a", initial]]) };
  let state = {
    sessions: {
      local: {
        agents: new Map([
          ["a", initial],
          ["b", agent("claude-opus-5", "claude-opus-5")],
        ]),
      },
      remote,
    },
    drafts: { untouched: true },
  };
  let enabled = true,
    writes = 0;
  const listeners = new Set<() => void>(),
    registryListeners = new Set<() => void>();
  const store = {
    getState: () => state,
    setState(patch: any) {
      state = { ...state, ...patch };
      writes++;
      listeners.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const registry = {
    getSnapshot: () =>
      enabled
        ? [
            {
              id: "aster",
              serverId: "local",
              lifetime: { signal: { aborted: false } },
            },
          ]
        : [],
    subscribe(fn: () => void) {
      registryListeners.add(fn);
      return () => {
        registryListeners.delete(fn);
      };
    },
  };
  const dispose = installRuntimeModelPresentation(store, registry);
  assert.equal(writes, 1);
  assert.equal(
    state.sessions.local.agents.get("a")!.runtimeInfo.model,
    "claude-fable-5-2",
  );
  assert.equal(
    state.sessions.local.agents.get("a")!.runtimeInfo.sessionId,
    "unchanged",
  );
  assert.equal(initial.runtimeInfo.model, "claude-fable-5");
  assert.equal(state.sessions.remote, remote);
  assert.deepEqual(state.drafts, { untouched: true });
  store.setState({
    sessions: {
      ...state.sessions,
      local: { agents: new Map([["a", agent()]]) },
    },
  });
  assert.equal(writes, 3);
  assert.equal(
    state.sessions.local.agents.get("a")!.runtimeInfo.model,
    "claude-fable-5-2",
  );
  enabled = false;
  store.setState({
    sessions: {
      ...state.sessions,
      local: { agents: new Map([["a", agent()]]) },
    },
  });
  assert.equal(
    state.sessions.local.agents.get("a")!.runtimeInfo.model,
    "claude-fable-5",
  );
  enabled = true;
  registryListeners.forEach((fn) => fn());
  assert.equal(
    state.sessions.local.agents.get("a")!.runtimeInfo.model,
    "claude-fable-5-2",
  );
  dispose();
  assert.equal(listeners.size, 0);
  assert.equal(registryListeners.size, 0);
  store.setState({
    sessions: {
      ...state.sessions,
      local: { agents: new Map([["a", agent()]]) },
    },
  });
  assert.equal(
    state.sessions.local.agents.get("a")!.runtimeInfo.model,
    "claude-fable-5",
  );
});
