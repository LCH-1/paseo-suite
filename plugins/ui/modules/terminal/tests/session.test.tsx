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
  let resolvePage: ((page: object) => void) | undefined;
  let deferred = false;
  const api = { agents: {
    ref: (id: string) => ({ timeline: {
      subscribe: (callback: (event: PaseoAgentTimelineEvent) => void) => {
        active.add(id); callbacks.set(id, callback);
        return Object.assign(() => { active.delete(id); callbacks.delete(id); }, { ready: Promise.resolve() });
      },
      refetch: async () => {
        calls.push(id);
        if (fail) throw new Error("connection failed");
        if (deferred) return new Promise((resolve) => { resolvePage = resolve; });
        return { agentId: id, entries: [], epoch: id, error: null };
      },
    } }),
  } } as unknown as PaseoApi;
  return { api, active, callbacks, calls,
    fail: (value: boolean) => { fail = value; },
    defer: () => { deferred = true; },
    resolve: () => resolvePage?.({ agentId: "old", entries: [], epoch: "old", error: null }),
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
