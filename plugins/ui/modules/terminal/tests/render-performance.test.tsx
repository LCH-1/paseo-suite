import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { transformSync } from "esbuild";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { TimelinePage } from "../client/session";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const require = createRequire(import.meta.url);
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
const native = {
  Platform: { OS: "web" },
  View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", ActivityIndicator: "ActivityIndicator",
  FlatList: ({ data, renderItem, keyExtractor }: { data: unknown[]; renderItem(input: { item: unknown }): React.ReactNode; keyExtractor(item: unknown): string }) => React.createElement("FlatList", null,
    data.map(item => React.createElement(React.Fragment, { key: keyExtractor(item) }, renderItem({ item })))),
};
function load<T>(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  const source = transformSync(readFileSync(path.join(client, file), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
  vm.runInNewContext(source, { module, exports: module.exports, require: (id: string) => id in mocks ? mocks[id] : require(id), ...globals }, { filename: file });
  return module.exports as T;
}
const theme = { colors: { foreground: "white", foregroundMuted: "gray", surface0: "black", surface1: "black", surface2: "black", border: "gray", accent: "blue", statusSuccess: "green", statusDanger: "red", statusWarning: "yellow" } };
const settle = () => new Promise(resolve => setImmediate(resolve));

test("닫힌 도구 상세는 직렬화하지 않고 펼칠 때만 상세를 표시한다", async () => {
  const { TimelineRow } = load<typeof import("../client/timeline")>("timeline.tsx", { "react-native": native });
  let serializations = 0;
  const detail = { toJSON() { serializations++; return { result: "large result" }; } };
  const entry = { seqStart: 1, item: { type: "tool_call", name: "Tool", status: "completed", detail } } as unknown as TimelinePage["entries"][number];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TimelineRow entry={entry} theme={theme as PluginScreenProps["theme"]} />); });
  assert.equal(serializations, 0);
  const toggle = () => renderer.root.findByType("Pressable").props.onPress();
  await act(async () => toggle());
  assert.equal(serializations, 1);
  assert.equal(JSON.stringify(renderer.toJSON()).includes("large result"), true);
  await act(async () => toggle());
  assert.equal(serializations, 1);
  await act(async () => renderer.unmount());
});

function webFixture() {
  const values = new Map<string, string>();
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, Set<() => void>>();
  let sequence = 0;
  let writes = 0;
  let blocked = false;
  const storage = {
    getItem(key: string) { if (blocked) throw new Error("storage blocked"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw new Error("storage blocked"); writes++; values.set(key, value); },
    removeItem(key: string) { if (blocked) throw new Error("storage blocked"); writes++; values.delete(key); },
  };
  const web = load<typeof import("../client/web")>("web.ts", { "react-native": native }, {
    localStorage: storage,
    setTimeout: (callback: () => void) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    addEventListener: (type: string, callback: () => void) => {
      const current = listeners.get(type) ?? new Set(); current.add(callback); listeners.set(type, current);
    },
    removeEventListener: (type: string, callback: () => void) => { listeners.get(type)?.delete(callback); },
  });
  return {
    web, storage, values, timers, listeners,
    blockStorage() { blocked = true; },
    writes: () => writes,
    emit(type: string) { listeners.get(type)?.forEach(callback => callback()); },
    tick() { for (const callback of [...timers.values()]) callback(); },
  };
}

function terminalFixture(error = "", failCreates = 0, pendingSend?: Promise<void>, opened = ["initial"]) {
  const stored = webFixture();
  stored.web.writeTabs("host", { ids: opened, active: opened[0] ?? null });
  let refreshes = 0;
  let sends = 0;
  let creates = 0;
  const agent = (id: string) => ({ id, title: id, provider: "codex", model: "model", cwd: "/repo", status: "idle", pendingPermissions: [] });
  const directory = {
    agents: opened.map(agent), error, loading: false,
    refresh: () => { refreshes++; },
    upsert: (next: ReturnType<typeof agent>) => { directory.agents = [...directory.agents.filter(item => item.id !== next.id), next]; },
  };
  const pages = Object.fromEntries(opened.map(id => [id, { epoch: id, entries: [
    { seqStart: 1, item: { type: "tool_call", name: `${id} tool`, status: "completed", detail: { result: "retained detail" } } },
  ] }]));
  const { TimelineRow } = load<typeof import("../client/timeline")>("timeline.tsx", { "react-native": native });
  const api = { agents: {
    ref: (id: string) => ({ refresh: async () => ({ agent: agent(id) }), send: async () => { sends++; await pendingSend; } }),
    create: async () => {
      creates++;
      if (creates <= failCreates) throw new Error("creation failed");
      return { id: "created", refresh: async () => ({ agent: agent("created") }) };
    },
  } };
  const { TerminalScreen } = load<typeof import("../client/terminal")>("terminal.tsx", {
    "react-native": native,
    "@getpaseo/plugin/client": { usePaseo: () => api },
    "./web": stored.web,
    "./session": { useDirectory: () => directory, useTimeline: (_: unknown, id: string) => ({ page: pages[id] ?? null, loading: false, error: "", retry() {} }), message: (error: unknown) => error instanceof Error ? error.message : String(error) },
    "./timeline": { mono: "monospace", TimelineRow },
  });
  const props = { theme, host: { id: "host" }, layout: { compact: false } } as unknown as PluginScreenProps;
  return { TerminalScreen, props, stored, counts: () => ({ refreshes, sends, creates }) };
}
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(node => node.type === "Pressable" && node.props.accessibilityLabel === label)[0];
}

test("세션 열기·전송·생성은 실시간 목록 구독을 다시 만들지 않는다", async () => {
  const fixture = terminalFixture();
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  await act(async () => renderer.root.findByProps({ accessibilityLabel: "에이전트에게 메시지 보내기" }).props.onChangeText("hello"));
  await act(async () => { button(renderer, "전송 ↵").props.onPress(); await settle(); });
  assert.equal(fixture.counts().sends, 1);
  assert.equal(fixture.counts().refreshes, 0);
  await act(async () => button(renderer, "+").props.onPress());
  assert.equal(fixture.counts().refreshes, 0);
  await act(async () => button(renderer, "+ 새 세션").props.onPress());
  await act(async () => { button(renderer, "세션 만들기").props.onPress(); await settle(); });
  assert.equal(fixture.counts().creates, 1);
  assert.equal(fixture.counts().refreshes, 0);
  assert.equal(renderer.root.findAll(node => node.type === "Pressable" && node.props.accessibilityRole === "tab" && node.props.accessibilityLabel === "created").length, 1);
  await act(async () => renderer.unmount());
});

test("목록 오류는 보이는 재시도 버튼으로 다시 조회할 수 있다", async () => {
  const fixture = terminalFixture("connection failed");
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  await act(async () => button(renderer, "+").props.onPress());
  await act(async () => button(renderer, "목록 다시 불러오기").props.onPress());
  assert.equal(fixture.counts().refreshes, 1);
  await act(async () => renderer.unmount());
});

test("같은 프레임의 세션 생성 요청은 한 번만 처리한다", async () => {
  const fixture = terminalFixture();
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  await act(async () => button(renderer, "+").props.onPress());
  await act(async () => button(renderer, "+ 새 세션").props.onPress());
  await act(async () => {
    const press = button(renderer, "세션 만들기").props.onPress;
    press();
    press();
    await settle();
  });
  assert.equal(fixture.counts().creates, 1);
  assert.equal(renderer.root.findAll(node => node.type === "Pressable" && node.props.accessibilityRole === "tab" && node.props.accessibilityLabel === "created").length, 1);
  await act(async () => renderer.unmount());
});

test("세션 생성 실패 후 오류를 표시하고 다시 생성할 수 있다", async () => {
  const fixture = terminalFixture("", 1);
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  await act(async () => button(renderer, "+").props.onPress());
  await act(async () => button(renderer, "+ 새 세션").props.onPress());
  await act(async () => { button(renderer, "세션 만들기").props.onPress(); await settle(); });
  assert.equal(JSON.stringify(renderer.toJSON()).includes("creation failed"), true);
  assert.equal(button(renderer, "세션 만들기").props.disabled, false);
  await act(async () => { button(renderer, "세션 만들기").props.onPress(); await settle(); });
  assert.equal(fixture.counts().creates, 2);
  assert.equal(JSON.stringify(renderer.toJSON()).includes("creation failed"), false);
  assert.equal(renderer.root.findAll(node => node.type === "Pressable" && node.props.accessibilityRole === "tab" && node.props.accessibilityLabel === "created").length, 1);
  await act(async () => renderer.unmount());
});

test("터미널 초안은 호스트 전환과 화면 재진입 후 복원하고 종료 시 저장한다", async () => {
  const fixture = terminalFixture();
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  const composer = () => renderer.root.findByProps({ accessibilityLabel: "에이전트에게 메시지 보내기" });
  await act(async () => composer().props.onChangeText("host draft"));
  await act(async () => renderer.update(<TerminalScreen {...fixture.props} host={{ ...fixture.props.host, id: "other" }} />));
  assert.equal(fixture.stored.values.get("terminal-draft:host:initial"), "host draft");
  await act(async () => renderer.update(<TerminalScreen {...fixture.props} />));
  assert.equal(composer().props.value, "host draft");
  await act(async () => renderer.unmount());
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  assert.equal(composer().props.value, "host draft");
  await act(async () => renderer.unmount());
  assert.equal(fixture.stored.listeners.get("pagehide")?.size, 0);
});

test("전송 중 새로 작성한 초안은 늦은 성공 응답 후에도 남는다", async () => {
  let complete!: () => void;
  const fixture = terminalFixture("", 0, new Promise<void>(resolve => { complete = resolve; }));
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  const composer = () => renderer.root.findByProps({ accessibilityLabel: "에이전트에게 메시지 보내기" });
  await act(async () => composer().props.onChangeText("sent message"));
  await act(async () => { button(renderer, "전송 ↵").props.onPress(); await settle(); });
  await act(async () => composer().props.onChangeText("new unsent draft"));
  await act(async () => { complete(); await settle(); });
  assert.equal(composer().props.value, "new unsent draft");
  await act(async () => renderer.unmount());
  assert.equal(fixture.stored.values.get("terminal-draft:host:initial"), "new unsent draft");
});

test("성공한 전송의 초안만 저장소에서도 지운다", async () => {
  const fixture = terminalFixture();
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  const composer = () => renderer.root.findByProps({ accessibilityLabel: "에이전트에게 메시지 보내기" });
  await act(async () => composer().props.onChangeText("sent message"));
  fixture.stored.emit("pagehide");
  assert.equal(fixture.stored.values.get("terminal-draft:host:initial"), "sent message");
  await act(async () => { button(renderer, "전송 ↵").props.onPress(); await settle(); });
  assert.equal(composer().props.value, "");
  await act(async () => renderer.unmount());
  assert.equal(fixture.stored.values.has("terminal-draft:host:initial"), false);
});

test("초안은 호스트·세션별로 분리하고 입력 저장을 합친 뒤 pagehide에 남은 변경을 저장한다", () => {
  const fixture = webFixture();
  const { web } = fixture;
  const cleanup = web.bindDraftFlush("host");
  for (let index = 0; index < 100; index++) web.writeDraft("host", "one", `draft ${index}`);
  web.writeDraft("host", "two", "another draft");
  web.writeDraft("other", "one", "other host");
  assert.equal(web.readDraft("host", "one"), "draft 99");
  assert.equal(web.readDraft("other", "one"), "other host");
  assert.equal(fixture.writes(), 0);
  assert.equal(fixture.timers.size, 3);
  fixture.emit("pagehide");
  assert.equal(fixture.writes(), 2);
  assert.equal(fixture.timers.size, 1);
  fixture.tick();
  assert.equal(fixture.writes(), 3);
  assert.equal(fixture.values.get("terminal-draft:other:one"), "other host");
  cleanup();
});

test("저장된 초안을 읽고 저장소가 차단되어도 메모리 초안을 유지한다", () => {
  const fixture = webFixture();
  fixture.values.set("terminal-draft:host:one", "restored draft");
  assert.equal(fixture.web.readDraft("host", "one"), "restored draft");
  fixture.blockStorage();
  fixture.web.writeDraft("host", "one", "latest draft");
  fixture.web.flushDrafts("host");
  assert.equal(fixture.web.readDraft("host", "one"), "latest draft");
  assert.equal(fixture.web.readDraft("other", "one"), "");
  assert.equal(fixture.timers.size, 0);
});

test("최근 세 대화만 같은 순서와 identity로 유지하고 닫은 대화는 즉시 제거한다", async () => {
  const fixture = terminalFixture("", 0, undefined, ["a", "b", "c", "d"]);
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  const panels = () => renderer.root.findAll(node => node.type === "View" && node.props.nativeID?.startsWith("terminal-conversation-"));
  const ids = () => panels().map(node => node.props.nativeID);
  const select = (id: string) => renderer.root.findByProps({ accessibilityRole: "tab", accessibilityLabel: id }).props.onPress();
  const first = panels()[0];
  await act(async () => select("b"));
  await act(async () => select("c"));
  await act(async () => select("a"));
  assert.equal(panels()[0], first);
  assert.deepEqual(ids(), ["terminal-conversation-a", "terminal-conversation-b", "terminal-conversation-c"]);
  await act(async () => select("d"));
  assert.deepEqual(ids(), ["terminal-conversation-a", "terminal-conversation-c", "terminal-conversation-d"]);
  assert.equal(panels()[0], first);
  await act(async () => button(renderer, "+").props.onPress());
  assert.equal(renderer.root.findAll(node => node.type === "View" && node.props.nativeID === "terminal-conversation-d")[0].props.accessibilityElementsHidden, true);
  await act(async () => button(renderer, "닫기").props.onPress());
  const tab = renderer.root.findByProps({ accessibilityRole: "tab", accessibilityLabel: "c" });
  const close = tab.parent!.findAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "×")[0];
  await act(async () => close.props.onPress());
  assert.deepEqual(ids(), ["terminal-conversation-a", "terminal-conversation-d"]);
  await act(async () => renderer.unmount());
});

test("대화를 왕복하거나 세션 선택 창을 닫아도 펼친 도구 상세는 유지한다", async () => {
  const fixture = terminalFixture("", 0, undefined, ["a", "b"]);
  const { TerminalScreen } = fixture;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TerminalScreen {...fixture.props} />); });
  await act(async () => button(renderer, "a tool  완료 상세 펼치기").props.onPress());
  await act(async () => renderer.root.findByProps({ accessibilityRole: "tab", accessibilityLabel: "b" }).props.onPress());
  await act(async () => renderer.root.findByProps({ accessibilityRole: "tab", accessibilityLabel: "a" }).props.onPress());
  assert.ok(button(renderer, "a tool  완료 상세 접기"));
  await act(async () => button(renderer, "+").props.onPress());
  await act(async () => button(renderer, "닫기").props.onPress());
  assert.ok(button(renderer, "a tool  완료 상세 접기"));
  await act(async () => renderer.unmount());
});
