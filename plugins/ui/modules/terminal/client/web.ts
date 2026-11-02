import { Platform } from "react-native";

type SavedTabs = { ids: string[]; active: string | null };
type KeyEvent = {
  key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
  isComposing: boolean; keyCode?: number; defaultPrevented: boolean;
  target: { id?: string; tagName?: string; closest?(selector: string): unknown } | null;
  preventDefault(): void;
};
type WebHost = {
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  addEventListener?(type: string, callback: () => void): void;
  removeEventListener?(type: string, callback: () => void): void;
  document?: {
    addEventListener(type: string, callback: (event: KeyEvent) => void, capture: boolean): void;
    removeEventListener(type: string, callback: (event: KeyEvent) => void, capture: boolean): void;
  };
};
const memory = new Map<string, SavedTabs>();
const draftMemory = new Map<string, string>();
const pendingDrafts = new Map<string, { host: string; timer: ReturnType<typeof setTimeout> }>();
const web = globalThis as unknown as WebHost;

function draftKey(host: string, agent: string) {
  return `terminal-draft:${encodeURIComponent(host)}:${encodeURIComponent(agent)}`;
}

export function readDraft(host: string, agent: string): string {
  const key = draftKey(host, agent);
  if (draftMemory.has(key)) return draftMemory.get(key)!;
  let value = "";
  if (Platform.OS === "web") {
    try { value = web.localStorage?.getItem(key) ?? ""; }
    catch { /* 저장소가 차단되어도 현재 창의 초안은 메모리에 보관한다. */ }
  }
  draftMemory.set(key, value);
  return value;
}

function flushDraft(key: string) {
  const pending = pendingDrafts.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDrafts.delete(key);
  if (Platform.OS !== "web") return;
  try {
    const value = draftMemory.get(key) ?? "";
    if (value) web.localStorage?.setItem(key, value);
    else web.localStorage?.removeItem(key);
  } catch { /* 저장 실패 시에도 현재 창의 최신 초안을 유지한다. */ }
}

export function writeDraft(host: string, agent: string, value: string) {
  const key = draftKey(host, agent);
  if (draftMemory.get(key) === value) return;
  draftMemory.set(key, value);
  if (Platform.OS !== "web") return;
  const previous = pendingDrafts.get(key);
  if (previous) clearTimeout(previous.timer);
  pendingDrafts.set(key, { host, timer: setTimeout(() => flushDraft(key), 250) });
}

export function flushDrafts(host: string) {
  for (const [key, pending] of pendingDrafts) if (pending.host === host) flushDraft(key);
}

export function bindDraftFlush(host: string) {
  const flush = () => flushDrafts(host);
  if (Platform.OS === "web") {
    web.addEventListener?.("pagehide", flush);
    web.addEventListener?.("beforeunload", flush);
  }
  return () => {
    web.removeEventListener?.("pagehide", flush);
    web.removeEventListener?.("beforeunload", flush);
    flush();
  };
}

export function readTabs(host: string): SavedTabs {
  if (Platform.OS === "web") {
    try {
      const raw = web.localStorage?.getItem(`terminal-tabs:${host}`);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === "object" && "ids" in value && Array.isArray(value.ids)
          && value.ids.every((id) => typeof id === "string")) {
          const ids = [...new Set(value.ids as string[])];
          const active = "active" in value && typeof value.active === "string" && ids.includes(value.active)
            ? value.active : ids[0] ?? null;
          return { ids, active };
        }
      }
    } catch {
      // 브라우저 저장소가 차단되어도 현재 창에서는 탭을 유지한다.
    }
  }
  return memory.get(host) ?? { ids: [], active: null };
}

export function writeTabs(host: string, value: SavedTabs) {
  memory.set(host, value);
  if (Platform.OS === "web") {
    try { web.localStorage?.setItem(`terminal-tabs:${host}`, JSON.stringify(value)); }
    catch { /* 저장소 사용 권한이 없는 클라이언트는 메모리 상태를 사용한다. */ }
  }
}

export function bindKeys(actions: {
  next(delta: number): void; select(index: number): void;
  add(): void; close(): void; send(): void;
}) {
  if (Platform.OS !== "web" || !web.document) return () => {};
  const document = web.document;
  const handler = (event: KeyEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === "Process") return;
    if (!event.target?.closest?.("#terminal-tabs-root")) return;
    const command = event.ctrlKey || event.metaKey;
    let action: (() => void) | undefined;
    if (event.key === "Enter" && !event.shiftKey && !command && !event.altKey
      && event.target.id === "terminal-tabs-composer") action = actions.send;
    if (command && event.shiftKey && event.key.toLowerCase() === "t") action = actions.add;
    if (command && event.shiftKey && event.key.toLowerCase() === "w") action = actions.close;
    if (command && event.key === "PageDown") action = () => actions.next(1);
    if (command && event.key === "PageUp") action = () => actions.next(-1);
    if (event.altKey && /^[1-9]$/.test(event.key)) action = () => actions.select(Number(event.key) - 1);
    if (action) { event.preventDefault(); action(); }
  };
  document.addEventListener("keydown", handler, true);
  return () => document.removeEventListener("keydown", handler, true);
}
