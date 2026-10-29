import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PaseoApi, PaseoAgent } from "../client/paseo";
import { useDirectory } from "../client/session";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const settle = () => new Promise((resolve) => setImmediate(resolve));
type Page = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
type Subscription = NonNullable<Page["subscription"]>;
type Observer = Parameters<Subscription["subscribe"]>[0];

const agent = (id: string, title = id) => ({ id, title, archivedAt: null }) as PaseoAgent;
function page(agents: PaseoAgent[], nextCursor: string | null = null): Page {
  return { entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor } } as Page;
}
function harness() {
  const updates = new Set<(value: object) => void>();
  const calls: Array<{ subscribe?: {}; page: { cursor?: string } }> = [];
  const subscriptions: Array<{ observer: Observer | null; releases: number; unsubscribes: number; releaseWait: Promise<void> | null }> = [];
  let first = async () => page([agent("first")], "next");
  const pages = new Map<string, () => Promise<Page>>([["next", async () => page([agent("second")])]]);
  const api = { agents: {
    list: async (options: { subscribe?: {}; page: { cursor?: string } }) => {
      calls.push(options);
      const result = await (options.page.cursor ? pages.get(options.page.cursor)!() : first());
      if (!options.subscribe) return result;
      const record = { observer: null as Observer | null, releases: 0, unsubscribes: 0, releaseWait: null as Promise<void> | null };
      subscriptions.push(record);
      return { ...result, subscription: {
        ready: Promise.resolve(result),
        subscribe: (observer: Observer) => {
          record.observer = observer;
          observer.snapshot(result);
          return () => { record.unsubscribes++; record.observer = null; };
        },
        release: async () => { record.releases++; await record.releaseWait; },
      } };
    },
    subscribe: (callback: (value: object) => void) => { updates.add(callback); return () => { updates.delete(callback); }; },
  } } as unknown as PaseoApi;
  let state!: ReturnType<typeof useDirectory>;
  function Probe() { state = useDirectory(api); return null; }
  let renderer!: ReactTestRenderer;
  return {
    calls, subscriptions, updates, pages,
    setFirst(read: typeof first) { first = read; },
    get state() { return state; },
    async mount() { await act(async () => { renderer = create(<Probe />); await settle(); }); },
    async unmount() { await act(async () => renderer.unmount()); },
    emit(update: object) { updates.forEach((callback) => callback(update)); },
  };
}

test("목록 구독은 첫 페이지만 열고 종료할 때 observer와 handle을 해제한다", async () => {
  const h = harness();
  await h.mount();
  assert.deepEqual(h.calls.map((call) => call.page.cursor), [undefined, "next"]);
  assert.deepEqual(h.calls[0].subscribe, {});
  assert.equal(h.calls[1].subscribe, undefined);
  assert.equal(h.subscriptions.length, 1);
  assert.deepEqual(h.state.agents.map((agent) => agent.id), ["first", "second"]);
  await h.unmount();
  assert.equal(h.updates.size, 0);
  assert.equal(h.subscriptions[0].releases, 1);
  assert.equal(h.subscriptions[0].unsubscribes, 1);
});

test("오래된 페이지가 조회 중 이름 변경·제거·로컬 snapshot을 덮어쓰지 않는다", async () => {
  const h = harness();
  let resolve!: (value: Page) => void;
  h.pages.set("next", () => new Promise((done) => { resolve = done; }));
  await h.mount();
  await act(async () => {
    h.emit({ kind: "upsert", agent: agent("first", "renamed") });
    h.emit({ kind: "remove", agentId: "second" });
    h.state.upsert(agent("local", "local-snapshot"));
    resolve(page([agent("second")]));
    await settle();
  });
  assert.deepEqual(h.state.agents.map(({ id, title }) => [id, title]), [["first", "renamed"], ["local", "local-snapshot"]]);
  await h.unmount();
});

test("최초 구독 준비 중 로컬에서 확인한 변경도 첫 snapshot보다 우선한다", async () => {
  const h = harness();
  let resolve!: (value: Page) => void;
  h.setFirst(() => new Promise((done) => { resolve = done; }));
  await h.mount();
  await act(async () => {
    h.state.upsert(agent("first", "fresh-local"));
    h.emit({ kind: "remove", agentId: "removed" });
    resolve(page([agent("first", "stale"), agent("removed")]));
    await settle();
  });
  assert.deepEqual(h.state.agents.map(({ id, title }) => [id, title]), [["first", "fresh-local"]]);
  await h.unmount();
});

test("재연결 snapshot이 이전 페이지를 대체하고 최신 이벤트를 보존한다", async () => {
  const h = harness();
  let resolve!: (value: Page) => void;
  h.pages.set("next", () => new Promise((done) => { resolve = done; }));
  await h.mount();
  await act(async () => {
    h.subscriptions[0].observer!.snapshot(page([agent("current")]));
    h.emit({ kind: "upsert", agent: agent("current", "latest") });
    resolve(page([agent("obsolete")]));
    await settle();
  });
  assert.deepEqual(h.state.agents.map(({ id, title }) => [id, title]), [["current", "latest"]]);
  assert.equal(h.subscriptions.length, 1);
  await h.unmount();
});

test("구독 준비 전 화면을 닫으면 늦게 도착한 handle을 한 번 해제한다", async () => {
  const h = harness();
  let resolve!: (value: Page) => void;
  h.setFirst(() => new Promise((done) => { resolve = done; }));
  await h.mount();
  await h.unmount();
  await act(async () => { resolve(page([agent("late")])); await settle(); });
  assert.equal(h.subscriptions.length, 1);
  assert.equal(h.subscriptions[0].releases, 1);
  assert.equal(h.subscriptions[0].observer, null);
});

test("수동 새로고침은 이전 구독을 해제하고 남은 callback을 무시한다", async () => {
  const h = harness();
  await h.mount();
  const previous = h.subscriptions[0].observer!;
  h.setFirst(async () => page([agent("fresh")]));
  await act(async () => { h.state.refresh(); await settle(); });
  await act(async () => { previous.snapshot(page([agent("obsolete")])); });
  assert.equal(h.subscriptions[0].releases, 1);
  assert.equal(h.subscriptions.length, 2);
  assert.deepEqual(h.state.agents.map((agent) => agent.id), ["fresh"]);
  await h.unmount();
});

test("수동 갱신은 이전 구독의 비동기 해제 완료 후 새 구독을 연다", async () => {
  const h = harness();
  await h.mount();
  let finishRelease!: () => void;
  h.subscriptions[0].releaseWait = new Promise((done) => { finishRelease = done; });
  h.setFirst(async () => page([agent("fresh")]));
  await act(async () => { h.state.refresh(); await settle(); });
  assert.equal(h.subscriptions[0].releases, 1);
  assert.equal(h.subscriptions.length, 1);
  await act(async () => { finishRelease(); await settle(); });
  assert.equal(h.subscriptions.length, 2);
  assert.deepEqual(h.state.agents.map((agent) => agent.id), ["fresh"]);
  await h.unmount();
});

test("구독 오류 후 구독을 교체하고 화면 종료 시 재시도 예약을 취소한다", async () => {
  const h = harness();
  await h.mount();
  await act(async () => {
    h.subscriptions[0].observer!.error?.(new Error("directory disconnected"));
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  assert.equal(h.subscriptions[0].releases, 1);
  assert.equal(h.subscriptions.length, 2);
  assert.equal(h.state.error, "");
  await act(async () => { h.subscriptions[1].observer!.error?.(new Error("offline")); });
  await h.unmount();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(h.subscriptions.length, 2);
});
