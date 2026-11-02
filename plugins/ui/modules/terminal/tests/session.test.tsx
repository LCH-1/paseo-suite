import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PaseoApi, PaseoAgentTimelineEvent } from "../client/paseo";
import { useTimeline, useDirectory } from "../client/session";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const active = new Set<string>();
  const callbacks = new Map<string, (event: PaseoAgentTimelineEvent) => void>();
  const calls: string[] = [];
  let fail = false;
  let resolvePage: (() => void) | undefined;
  let deferred = false;
  const epochs = new Map<string, string>();
  const result = (id: string) => ({ agentId: id, agent: { id, title: id, status: "idle" },
    entries: [{ seqStart: 1, item: { type: "assistant_message", text: id } }], epoch: epochs.get(id) ?? id, error: null });
  const api = { agents: {
    ref: (id: string) => ({ timeline: {
      subscribe: (callback: (event: PaseoAgentTimelineEvent) => void) => {
        active.add(id); callbacks.set(id, callback);
        return Object.assign(() => { active.delete(id); callbacks.delete(id); }, { ready: Promise.resolve() });
      },
      refetch: async () => {
        calls.push(id);
        if (fail) throw new Error("connection failed");
        if (deferred) return new Promise((resolve) => { resolvePage = () => resolve(result(id)); });
        return result(id);
      },
    } }),
  } } as unknown as PaseoApi;
  return { api, active, callbacks, calls,
    fail: (value: boolean) => { fail = value; },
    defer: (value = true) => { deferred = value; },
    epoch: (id: string, epoch: string) => { epochs.set(id, epoch); },
    resolve: () => resolvePage?.(),
  };
}

test("탭 전환과 닫기에서 활성 세션 구독만 유지한다", async () => {
  const mock = mockApi();
  let state: ReturnType<typeof useTimeline>;
  function Probe({ id }: { id: string | null }) { state = useTimeline(mock.api, id); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe id="first" />); await settle(); });
  assert.deepEqual([...mock.active], ["first"]);
  assert.equal(state!.page?.agentId, "first");
  await act(async () => { renderer!.update(<Probe id="second" />); await settle(); });
  assert.deepEqual([...mock.active], ["second"]);
  assert.equal(state!.page?.agentId, "second");
  await act(async () => { renderer!.update(<Probe id={null} />); await settle(); });
  assert.equal(mock.active.size, 0);
  assert.equal(state!.page, null);
  await act(async () => renderer!.unmount());
});

test("다시 연 대화는 캐시된 내용을 즉시 표시하고 활성 구독 하나로 최신 이력을 동기화한다", async () => {
  const mock = mockApi();
  let state!: ReturnType<typeof useTimeline>;
  function Probe({ id }: { id: string }) { state = useTimeline(mock.api, id); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe key="a" id="a" />); await settle(); });
  const entries = state.page!.entries;
  await act(async () => { renderer.update(<Probe key="b" id="b" />); await settle(); });
  mock.defer();
  await act(async () => { renderer.update(<Probe key="a" id="a" />); await settle(); });
  assert.equal(state.page!.entries, entries);
  assert.equal(state.page!.agentId, "a");
  assert.equal(state.page!.agent, null);
  assert.equal(state.loading, false);
  assert.deepEqual([...mock.active], ["a"]);
  assert.deepEqual(mock.calls, ["a", "b", "a"]);
  mock.epoch("a", "updated");
  await act(async () => { mock.resolve(); await settle(); });
  assert.equal(state.page!.epoch, "updated");
  await act(async () => renderer.unmount());
  assert.equal(mock.active.size, 0);
});

test("구독 중복 생성 없이 몰린 스트림 이벤트를 병합하고 재연결 때 새 이력을 읽는다", async () => {
  const mock = mockApi();
  function Probe() { useTimeline(mock.api, "active"); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe />); await settle(); });
  await act(async () => {
    for (let index = 0; index < 100; index++) mock.callbacks.get("active")!({ agentId: "active", event: { type: "subscription_restored" }, subscriptionId: "reconnected" });
    await new Promise((resolve) => setTimeout(resolve, 420));
  });
  assert.deepEqual(mock.calls, ["active", "active"]);
  assert.equal(mock.active.size, 1);
  await act(async () => renderer!.unmount());
  assert.equal(mock.active.size, 0);
});

test("이전 탭에서 늦게 도착한 응답은 현재 탭에 반영하지 않는다", async () => {
  const mock = mockApi(); mock.defer();
  let state: ReturnType<typeof useTimeline>;
  function Probe({ id }: { id: string | null }) { state = useTimeline(mock.api, id); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe id="old" />); await settle(); });
  await act(async () => { renderer!.update(<Probe id={null} />); await settle(); mock.resolve(); await settle(); });
  assert.equal(state!.page, null);
  assert.equal(state!.loading, false);
  await act(async () => renderer!.unmount());
});

test("조회 실패를 표시하고 다시 연결할 때 이전 구독을 정리한다", async () => {
  const mock = mockApi(); mock.fail(true);
  let state: ReturnType<typeof useTimeline>;
  function Probe() { state = useTimeline(mock.api, "active"); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe />); await settle(); });
  assert.equal(state!.error, "connection failed");
  assert.equal(state!.loading, false);
  mock.fail(false);
  await act(async () => { state!.retry(); await settle(); });
  assert.equal(state!.error, "");
  assert.equal(mock.active.size, 1);
  await act(async () => renderer!.unmount());
});

test("구독 오류 뒤 재연결은 캐시된 메시지를 유지하면서 새 이력을 적용한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = mockApi();
  let state!: ReturnType<typeof useTimeline>;
  function Probe() { state = useTimeline(mock.api, "active"); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe />); await settle(); });
  const previous = state.page;
  await act(async () => { mock.callbacks.get("active")!({ agentId: "active", event: { type: "error", error: "connection lost" }, subscriptionId: "lost" }); });
  assert.equal(state.error, "connection lost");
  assert.equal(state.page, previous);
  assert.equal(state.loading, false);
  mock.epoch("active", "reconnected");
  await act(async () => {
    mock.callbacks.get("active")!({ agentId: "active", event: { type: "subscription_restored" }, subscriptionId: "restored" });
    t.mock.timers.tick(351);
    await settle();
  });
  assert.equal(state.page?.epoch, "reconnected");
  assert.equal(state.error, "");
  assert.deepEqual([...mock.active], ["active"]);
  await act(async () => renderer.unmount());
});

test("API가 바뀌면 같은 agent ID의 다른 호스트 캐시와 늦은 응답을 표시하지 않는다", async () => {
  const first = mockApi();
  const second = mockApi();
  first.defer();
  second.epoch("same", "second-host");
  let state!: ReturnType<typeof useTimeline>;
  const renders: Array<{ api: PaseoApi; epoch: string | null }> = [];
  function Probe({ api }: { api: PaseoApi }) {
    state = useTimeline(api, "same");
    renders.push({ api, epoch: state.page?.epoch ?? null });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe api={first.api} />); await settle(); });
  await act(async () => { renderer.update(<Probe api={second.api} />); await settle(); });
  assert.equal(state.page?.epoch, "second-host");
  assert.equal(first.active.size, 0);
  assert.deepEqual([...second.active], ["same"]);
  await act(async () => { first.resolve(); await settle(); });
  assert.equal(state.page?.epoch, "second-host");
  assert.equal(renders.filter(render => render.api === second.api).every(render => render.epoch === null || render.epoch === "second-host"), true);
  await act(async () => { renderer.update(<Probe api={first.api} />); await settle(); });
  assert.equal(state.page, null);
  assert.equal(state.loading, true);
  assert.equal(second.active.size, 0);
  await act(async () => renderer.unmount());
});

test("replacement는 이전 캐시와 진행 중 응답을 버리고 교체된 이력만 표시한다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = mockApi();
  let state!: ReturnType<typeof useTimeline>;
  function Probe() { state = useTimeline(mock.api, "active"); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe />); await settle(); });
  mock.defer();
  await act(async () => {
    mock.callbacks.get("active")!({ agentId: "active", event: { type: "subscription_restored" }, subscriptionId: "pending" });
    t.mock.timers.tick(351);
    await settle();
  });
  assert.equal(mock.calls.length, 2);
  await act(async () => { mock.callbacks.get("active")!({ agentId: "active", event: { type: "replacement" }, subscriptionId: "replacement" }); });
  assert.equal(state.page, null);
  assert.equal(state.loading, true);
  mock.defer(false);
  await act(async () => { mock.resolve(); await settle(); });
  assert.equal(state.page, null);
  mock.epoch("active", "replacement-epoch");
  await act(async () => { t.mock.timers.tick(351); await settle(); });
  assert.equal(state.page?.epoch, "replacement-epoch");
  assert.equal(state.loading, false);
  assert.deepEqual(mock.calls, ["active", "active", "active"]);
  assert.deepEqual([...mock.active], ["active"]);
  await act(async () => renderer.unmount());
});

test("다시 읽기 실패는 표시 중인 캐시를 지우지 않고 재시도로 복구한다", async () => {
  const mock = mockApi();
  let state!: ReturnType<typeof useTimeline>;
  function Probe({ id }: { id: string }) { state = useTimeline(mock.api, id); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe id="a" />); await settle(); });
  const entries = state.page!.entries;
  await act(async () => { renderer.update(<Probe id="b" />); await settle(); });
  mock.fail(true);
  await act(async () => { renderer.update(<Probe id="a" />); await settle(); });
  assert.equal(state.page!.entries, entries);
  assert.equal(state.error, "connection failed");
  assert.equal(state.loading, false);
  mock.fail(false);
  mock.epoch("a", "recovered");
  await act(async () => { state.retry(); await settle(); });
  assert.equal(state.page?.epoch, "recovered");
  assert.equal(state.error, "");
  assert.deepEqual([...mock.active], ["a"]);
  await act(async () => renderer.unmount());
});

test("이력 캐시는 최근 8개만 유지하며 다시 연 항목을 최근 사용 순서에 반영한다", async () => {
  const mock = mockApi();
  let state!: ReturnType<typeof useTimeline>;
  function Probe({ id }: { id: string }) { state = useTimeline(mock.api, id); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe id="0" />); await settle(); });
  for (let index = 1; index <= 8; index++) {
    await act(async () => { renderer.update(<Probe id={String(index)} />); await settle(); });
  }
  mock.defer();
  await act(async () => { renderer.update(<Probe id="1" />); await settle(); });
  assert.equal(state.page?.agentId, "1");
  assert.equal(state.loading, false);
  await act(async () => { renderer.update(<Probe id="0" />); await settle(); });
  assert.equal(state.page, null);
  assert.equal(state.loading, true);
  await act(async () => { mock.resolve(); await settle(); });
  await act(async () => { renderer.update(<Probe id="1" />); await settle(); });
  assert.equal(state.page?.agentId, "1");
  await act(async () => { renderer.update(<Probe id="2" />); await settle(); });
  assert.equal(state.page, null);
  assert.equal(state.loading, true);
  await act(async () => renderer.unmount());
  assert.equal(mock.active.size, 0);
});

test("세션 목록의 다음 페이지와 삭제 이벤트를 처리한다", async () => {
  const cursors: (string | undefined)[] = [];
  let update: (value: object) => void = () => {};
  let released = false;
  const api = { agents: {
    list: async ({ page, subscribe }: { page: { cursor?: string }; subscribe?: {} }) => {
      cursors.push(page.cursor);
      const result = { entries: [{ agent: { id: page.cursor ? "second" : "first" } }], pageInfo: { nextCursor: page.cursor ? null : "next" } };
      return { ...result, ...(subscribe ? { subscription: {
        subscribe: (observer: { snapshot(value: typeof result): void }) => { observer.snapshot(result); return () => {}; },
        release: async () => { released = true; },
      } } : {}) };
    },
    subscribe: (callback: (value: object) => void) => { update = callback; return () => { released = true; }; },
  } } as unknown as PaseoApi;
  let state: ReturnType<typeof useDirectory>;
  function Probe() { state = useDirectory(api); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(<Probe />); await settle(); });
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.deepEqual(state!.agents.map((agent) => agent.id), ["first", "second"]);
  await act(async () => { update({ kind: "remove", agentId: "first" }); });
  assert.deepEqual(state!.agents.map((agent) => agent.id), ["second"]);
  await act(async () => renderer!.unmount());
  assert.equal(released, true);
});
