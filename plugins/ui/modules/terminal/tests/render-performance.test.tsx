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
function load<T>(file: string, mocks: Record<string, unknown>): T {
  const module = { exports: {} };
  const source = transformSync(readFileSync(path.join(client, file), "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
  vm.runInNewContext(source, { module, exports: module.exports, require: (id: string) => id in mocks ? mocks[id] : require(id) }, { filename: file });
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

function terminalFixture(error = "") {
  let refreshes = 0;
  let sends = 0;
  let creates = 0;
  const agent = (id: string) => ({ id, title: id, provider: "codex", model: "model", cwd: "/repo", status: "idle", pendingPermissions: [] });
  const directory = {
    agents: [agent("initial")], error, loading: false,
    refresh: () => { refreshes++; },
    upsert: (next: ReturnType<typeof agent>) => { directory.agents = [...directory.agents.filter(item => item.id !== next.id), next]; },
  };
  const api = { agents: {
    ref: (id: string) => ({ refresh: async () => ({ agent: agent(id) }), send: async () => { sends++; } }),
    create: async () => { creates++; return { id: "created", refresh: async () => ({ agent: agent("created") }) }; },
  } };
  const { TerminalScreen } = load<typeof import("../client/terminal")>("terminal.tsx", {
    "react-native": native,
    "@getpaseo/plugin/client": { usePaseo: () => api },
    "./web": { readTabs: () => ({ ids: ["initial"], active: "initial" }), writeTabs() {}, bindKeys: () => () => {} },
    "./session": { useDirectory: () => directory, useTimeline: () => ({ page: null, loading: false, error: "", retry() {} }), message: (error: unknown) => error instanceof Error ? error.message : String(error) },
    "./timeline": { mono: "monospace", TimelineRow: () => null },
  });
  const props = { theme, host: { id: "host" }, layout: { compact: false } } as unknown as PluginScreenProps;
  return { TerminalScreen, props, counts: () => ({ refreshes, sends, creates }) };
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
