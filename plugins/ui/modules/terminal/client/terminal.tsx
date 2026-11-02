import { usePaseo, type PluginScreenProps } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "./paseo";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { bindDraftFlush, bindKeys, readDraft, readTabs, writeDraft, writeTabs } from "./web";
import { message, useDirectory, useTimeline } from "./session";
import { mono, TimelineRow } from "./timeline";

type ButtonProps = { label: string; onPress(): void; color: string; disabled?: boolean };
function Button({ label, onPress, color, disabled }: ButtonProps) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={onPress} style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 9,
      opacity: disabled ? 0.35 : pressed ? 0.6 : 1 })}>
    <Text style={{ color, fontFamily: mono, fontSize: 12 }}>{label}</Text>
  </Pressable>;
}

const statusText = { idle: "준비", running: "작업 중", initializing: "시작 중", error: "오류", closed: "종료됨" };

type RetainedConversations = { ids: string[]; recent: string[] };
function retainConversations(current: RetainedConversations, opened: string[], active: string | null): RetainedConversations {
  const recent = current.recent.filter(id => opened.includes(id) && id !== active);
  if (active) recent.push(active);
  const retained = recent.slice(-3);
  const ids = current.ids.filter(id => retained.includes(id));
  if (active && !ids.includes(active)) ids.push(active);
  return ids.length === current.ids.length && ids.every((id, index) => current.ids[index] === id)
    && recent.length === current.recent.length && recent.every((id, index) => current.recent[index] === id)
    ? current : { ids, recent: retained };
}

export function TerminalScreen(props: PluginScreenProps) {
  return <HostTerminal key={props.host.id} {...props} />;
}

function HostTerminal({ theme, host, layout, navigation }: PluginScreenProps) {
  const paseo = usePaseo();
  const color = theme.colors;
  const directory = useDirectory(paseo);
  const [tabs, setTabs] = useState(() => readTabs(host.id));
  const [retention, setRetention] = useState<RetainedConversations>(() => ({ ids: [], recent: [] }));
  const retained = retainConversations(retention, tabs.ids, tabs.active);
  const [chooser, setChooser] = useState(false);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(tabs.ids.map((id) => [id, readDraft(host.id, id)])));
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const sendingNow = useRef(new Set<string>());
  const [creating, setCreating] = useState(false);
  const creatingNow = useRef(false);
  const [createError, setCreateError] = useState("");
  const [newForm, setNewForm] = useState(false);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const agents = directory.agents;
  const selected = agents.find((agent) => agent.id === tabs.active);
  const draft = tabs.active ? drafts[tabs.active] ?? "" : "";
  const input = useRef<TextInput>(null);
  const tabStrip = useRef<ScrollView>(null);
  const tabPositions = useRef(new Map<string, number>());
  const text = { color: color.foreground, fontFamily: mono, fontSize: 13 };
  const muted = { ...text, color: color.foregroundMuted };

  useEffect(() => writeTabs(host.id, tabs), [host.id, tabs]);
  useEffect(() => { if (retention !== retained) setRetention(retained); }, [retention, retained]);
  useEffect(() => bindDraftFlush(host.id), [host.id]);
  useEffect(() => {
    const x = tabs.active ? tabPositions.current.get(tabs.active) : undefined;
    if (x !== undefined) tabStrip.current?.scrollTo({ x: Math.max(0, x - 16), animated: false });
  }, [tabs.active, layout.compact]);

  const open = useCallback((id: string) => {
    setDrafts((current) => current[id] !== undefined ? current : { ...current, [id]: readDraft(host.id, id) });
    setTabs((current) => ({ ids: current.ids.includes(id) ? current.ids : [...current.ids, id], active: id }));
    setChooser(false); setQuery(""); setNewForm(false);
  }, [host.id]);

  const close = useCallback((id: string | null) => {
    if (!id) return;
    setTabs((current) => {
      const ids = current.ids.filter((item) => item !== id);
      return { ids, active: current.active === id ? ids[Math.min(current.ids.indexOf(id), ids.length - 1)] ?? null : current.active };
    });
  }, []);

  const add = useCallback(() => {
    setChooser(true); setNewForm(false); setCreateError("");
  }, []);

  const send = useCallback(async () => {
    const id = tabs.active;
    if (!id || !draft.trim() || sendingNow.current.has(id) || chooser) return;
    if (!selected || selected.status === "closed" || selected.status === "initializing"
      || selected.status === "running" || selected.pendingPermissions.length > 0) return;
    sendingNow.current.add(id);
    setSending((current) => ({ ...current, [id]: true }));
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      const handle = paseo.agents.ref(id);
      const fresh = await handle.refresh();
      if (!fresh) throw new Error("세션을 찾을 수 없습니다. 세션 목록에서 다시 열어주세요.");
      directory.upsert(fresh.agent);
      if (fresh.agent.pendingPermissions.length) throw new Error("기본 세션에서 승인 요청을 먼저 처리하세요.");
      if (fresh.agent.status === "running" || fresh.agent.status === "initializing" || fresh.agent.status === "closed")
        throw new Error("세션이 메시지를 받을 준비가 되면 다시 전송하세요.");
      await handle.send(draft);
      if (readDraft(host.id, id) === draft) {
        writeDraft(host.id, id, "");
        setDrafts((current) => current[id] === draft ? { ...current, [id]: "" } : current);
      }
    } catch (error) { setErrors((current) => ({ ...current, [id]: message(error) })); }
    finally {
      sendingNow.current.delete(id);
      setSending((current) => ({ ...current, [id]: false }));
    }
  }, [host.id, tabs.active, draft, chooser, selected, paseo, directory.upsert]);

  useEffect(() => bindKeys({
    next(delta) {
      setTabs((current) => {
        if (!current.ids.length) return current;
        const index = current.ids.indexOf(current.active ?? "");
        return { ...current, active: current.ids[(index + delta + current.ids.length) % current.ids.length] };
      });
    },
    select(index) { if (tabs.ids[index]) setTabs((current) => ({ ...current, active: current.ids[index] })); },
    add, close: () => close(tabs.active), send: () => void send(),
  }), [tabs, add, close, send]);

  useEffect(() => { if (!chooser) input.current?.focus(); }, [tabs.active, chooser]);

  async function create() {
    if (creatingNow.current || !cwd.trim() || !model.includes("/")) return;
    creatingNow.current = true;
    setCreating(true); setCreateError("");
    try {
      const handle = await paseo.agents.create({ cwd: cwd.trim(), config: { provider: model.trim() }, title: title.trim() || undefined });
      const result = await handle.refresh();
      if (!result) throw new Error("생성한 세션을 찾지 못했습니다. 세션 목록을 새로고침하세요.");
      directory.upsert(result.agent);
      open(handle.id);
    } catch (error) { setCreateError(message(error)); }
    finally { creatingNow.current = false; setCreating(false); }
  }

  function showForm() {
    setNewForm(true); setCwd(selected?.cwd ?? "");
    setModel(selected?.model ? `${selected.provider}/${selected.model}` : "");
    setTitle(""); setCreateError("");
  }

  const blocked = !selected || selected.status === "closed" || selected.status === "initializing"
    || selected.status === "running" || selected.pendingPermissions.length > 0 || !!sending[tabs.active ?? ""];
  const matches = agents.filter((agent) => !agent.archivedAt && `${agent.title ?? ""} ${agent.cwd} ${agent.provider}`.toLowerCase().includes(query.toLowerCase()));

  return <View nativeID="terminal-tabs-root" style={{ flex: 1, minHeight: 0, backgroundColor: color.surface0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: color.border,
      backgroundColor: color.surface1, minHeight: 39 }}>
      <ScrollView ref={tabStrip} horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ alignItems: "stretch" }}>
        {tabs.ids.map((id, index) => {
          const agent = agents.find((item) => item.id === id);
          const active = id === tabs.active;
          return <View key={id} onLayout={({ nativeEvent }) => {
            tabPositions.current.set(id, nativeEvent.layout.x);
            if (active) tabStrip.current?.scrollTo({ x: Math.max(0, nativeEvent.layout.x - 16), animated: false });
          }} style={{ flexDirection: "row", alignItems: "center", maxWidth: layout.compact ? 180 : 260,
            backgroundColor: active ? color.surface0 : color.surface1, borderRightWidth: 1, borderRightColor: color.border,
            borderTopWidth: 2, borderTopColor: active ? color.accent : color.surface1 }}>
            <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }}
              accessibilityLabel={agent?.title ?? `세션 ${index + 1}`} onPress={() => open(id)}
              style={{ paddingVertical: 11, paddingLeft: 12, paddingRight: 6, flexShrink: 1 }}>
              <Text numberOfLines={1} style={{ ...text, fontSize: 12, color: active ? color.foreground : color.foregroundMuted }}>
                <Text style={{ color: agent?.status === "running" ? color.statusSuccess : agent?.pendingPermissions.length ? color.statusWarning : color.foregroundMuted }}>
                  {agent?.status === "running" ? "●" : agent?.pendingPermissions.length ? "!" : "›"} </Text>
                {agent?.title ?? `세션 ${index + 1}`}
              </Text>
            </Pressable>
            <Button label="×" color={color.foregroundMuted} onPress={() => close(id)} />
          </View>;
        })}
      </ScrollView>
      <Button label="+" color={color.foreground} onPress={add} />
      <Button label={chooser ? "닫기" : "세션 ▾"} color={color.foregroundMuted} onPress={() => chooser ? setChooser(false) : add()} />
    </View>

    {chooser ? <View style={{ flex: 1, minHeight: 0, padding: layout.compact ? 12 : 24, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={text}>{newForm ? "새 세션" : "세션 열기"}</Text>
        <Button label={newForm ? "기존 세션" : "+ 새 세션"} color={color.accent} onPress={() => newForm ? setNewForm(false) : showForm()} />
      </View>
      {newForm ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }}>
        <Text style={muted}>작업 폴더</Text>
        <TextInput accessibilityLabel="작업 폴더" value={cwd} onChangeText={setCwd} placeholder="C:\\projects\\my-app" placeholderTextColor={color.foregroundMuted}
          style={{ ...text, padding: 12, backgroundColor: color.surface2 }} />
        <Text style={muted}>프로바이더/모델 ID · 기본 세션의 모델 ID를 사용할 수 있습니다.</Text>
        <TextInput accessibilityLabel="프로바이더와 모델" value={model} onChangeText={setModel} placeholder="provider/model" autoCapitalize="none" placeholderTextColor={color.foregroundMuted}
          style={{ ...text, padding: 12, backgroundColor: color.surface2 }} />
        <Text style={muted}>탭 이름 (선택)</Text>
        <TextInput accessibilityLabel="탭 이름" value={title} onChangeText={setTitle} placeholder="새 작업" placeholderTextColor={color.foregroundMuted}
          style={{ ...text, padding: 12, backgroundColor: color.surface2 }} />
        {!!createError && <Text selectable style={{ ...text, color: color.statusDanger }}>{createError}</Text>}
        <Button label={creating ? "생성 중…" : "세션 만들기"} color={color.accent} disabled={creating || !cwd.trim() || !model.includes("/")} onPress={() => void create()} />
      </ScrollView> : <>
        <TextInput accessibilityLabel="세션 검색" value={query} onChangeText={setQuery} autoFocus placeholder="제목, 폴더, 프로바이더로 검색" placeholderTextColor={color.foregroundMuted}
          style={{ ...text, padding: 12, backgroundColor: color.surface2 }} />
        {!!directory.error && <View style={{ gap: 4 }}>
          <Text selectable style={{ ...text, color: color.statusDanger }}>{directory.error}</Text>
          <Button label="목록 다시 불러오기" color={color.accent} onPress={directory.refresh} disabled={directory.loading} />
        </View>}
        {directory.loading && <ActivityIndicator color={color.accent} />}
        <FlatList data={matches} keyExtractor={(agent) => agent.id} keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={muted}>{directory.loading ? "세션을 불러오는 중…" : "일치하는 세션이 없습니다."}</Text>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => open(item.id)}
            style={({ pressed }) => ({ padding: 14, gap: 5, borderBottomWidth: 1, borderBottomColor: color.border, backgroundColor: pressed ? color.surface2 : color.surface0 })}>
            <Text numberOfLines={1} style={text}>{tabs.ids.includes(item.id) ? "✓ " : "  "}{item.title ?? "제목 없는 세션"}</Text>
            <Text numberOfLines={1} style={{ ...muted, fontSize: 11 }}>{item.provider} · {statusText[item.status]} · {item.cwd}</Text>
          </Pressable>} />
      </>}
    </View> : !tabs.active ? <View style={{ flex: 1, padding: layout.compact ? 24 : 40, justifyContent: "center", gap: 12 }}>
        <Text style={{ ...text, fontSize: 24 }}>❯ Terminal Tabs</Text>
        <Text style={muted}>대화에 집중하세요. 여러 작업은 위쪽 탭으로 전환합니다.</Text>
        <View style={{ alignSelf: "flex-start", backgroundColor: color.surface2 }}>
          <Button label="+ 세션 열기" color={color.accent} onPress={add} />
        </View>
        <Text style={{ ...muted, fontSize: 11 }}>탭을 닫아도 에이전트 작업은 계속됩니다.</Text>
      </View> : null}

    <View style={{ flex: 1, minHeight: 0, display: chooser || !tabs.active ? "none" : "flex" }}>
      {retained.ids.map(id => <View key={id} nativeID={`terminal-conversation-${id}`}
        accessibilityElementsHidden={chooser || id !== tabs.active} importantForAccessibility={chooser || id !== tabs.active ? "no-hide-descendants" : "auto"}
        pointerEvents={chooser || id !== tabs.active ? "none" : "auto"}
        style={{ flex: 1, minHeight: 0, display: id === tabs.active ? "flex" : "none" }}>
        <Conversation id={id} active={!chooser && id === tabs.active} theme={theme} agent={agents.find(agent => agent.id === id)}
          navigation={navigation} onSnapshot={directory.upsert} />
      </View>)}
    </View>

    {!chooser && tabs.active && <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 6, borderTopWidth: 1, borderTopColor: color.border }}>
      {!!errors[tabs.active] && <Text selectable style={{ ...text, color: color.statusDanger }}>{errors[tabs.active]}</Text>}
      <View style={{ flexDirection: "row", alignItems: "flex-end", backgroundColor: color.surface2, paddingLeft: 10 }}>
        <Text style={{ ...text, paddingBottom: 13, color: color.accent }}>❯</Text>
        <TextInput ref={input} nativeID="terminal-tabs-composer" accessibilityLabel="에이전트에게 메시지 보내기" multiline
          value={draft} onChangeText={(value) => { const id = tabs.active!; writeDraft(host.id, id, value); setDrafts((current) => ({ ...current, [id]: value })); }}
          placeholder={selected?.pendingPermissions.length ? "기본 세션에서 승인 요청을 처리하세요" : selected?.status === "running" ? "작업 중 · 다음 메시지를 미리 작성하세요" : "메시지를 입력하세요…"}
          placeholderTextColor={color.foregroundMuted} style={{ ...text, flex: 1, minHeight: 48, maxHeight: 160, padding: 12 }} />
        <Button label={sending[tabs.active] ? "전송 중…" : "전송 ↵"} color={color.accent} disabled={blocked || !draft.trim()} onPress={() => void send()} />
      </View>
      <View style={{ flexDirection: "row", gap: 10, paddingBottom: 8 }}>
        <Text numberOfLines={1} style={{ ...muted, flex: 1, fontSize: 11 }}>{selected ? `${selected.provider}${selected.model ? `/${selected.model}` : ""} · ${selected.cwd}` : "세션 정보 확인 중 · 세션 목록에서 다시 열 수 있습니다."}</Text>
        {!layout.compact && <Text style={{ ...muted, fontSize: 11 }}>Shift+Enter 줄바꿈 · Alt+1…9 탭</Text>}
      </View>
    </View>}
  </View>;
}

const Conversation = memo(function Conversation({ id, active, theme, agent, navigation, onSnapshot }: {
  id: string; active: boolean; theme: PluginScreenProps["theme"]; agent?: PaseoAgent; navigation: PluginScreenProps["navigation"];
  onSnapshot(agent: PaseoAgent): void;
}) {
  const paseo = usePaseo();
  const timeline = useTimeline(paseo, id, active);
  const color = theme.colors;
  const list = useRef<FlatList>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const snapshot = timeline.page?.agent ?? agent;
  useEffect(() => { if (active && timeline.page?.agent) onSnapshot(timeline.page.agent); }, [active, timeline.page, onSnapshot]);
  const text = { color: color.foregroundMuted, fontFamily: mono, fontSize: 12 };
  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 14, borderBottomWidth: 1, borderBottomColor: color.border }}>
      <Text style={{ ...text, flex: 1 }}>{snapshot ? statusText[snapshot.status] : "불러오는 중…"}
        {snapshot?.pendingPermissions.length ? " · 승인 대기" : ""}</Text>
      {navigation && <Button label="기본 세션 ↗" color={color.foregroundMuted} onPress={() => navigation.openAgent({ agentId: id })} />}
    </View>
    {snapshot?.pendingPermissions.length ? <View style={{ padding: 12, backgroundColor: color.surface1 }}>
      <Text style={{ ...text, color: color.statusWarning }}>승인 또는 질문 응답이 필요합니다. ‘기본 세션 ↗’에서 처리하세요.</Text>
    </View> : null}
    {!!timeline.error && <View style={{ padding: 12 }}><Text selectable style={{ ...text, color: color.statusDanger }}>{timeline.error}</Text>
      <Button label="다시 연결" color={color.accent} onPress={timeline.retry} /></View>}
    {timeline.loading && <ActivityIndicator color={color.accent} style={{ padding: 16 }} />}
    <FlatList ref={list} data={timeline.page?.entries ?? []} keyExtractor={(entry) => `${timeline.page?.epoch}:${entry.seqStart}`}
      style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
      initialNumToRender={20} windowSize={5} maxToRenderPerBatch={15}
      onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
        if (!active) return;
        following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
        setShowLatest(!following.current);
      }} scrollEventThrottle={100}
      onContentSizeChange={() => { if (active && following.current) list.current?.scrollToEnd({ animated: false }); }}
      ListHeaderComponent={timeline.page?.hasOlder ? <Text style={{ ...text, paddingVertical: 12 }}>최근 160개 항목 · 이전 기록은 기본 세션에서 확인하세요.</Text> : null}
      ListEmptyComponent={!timeline.loading && !timeline.error ? <Text style={{ ...text, paddingVertical: 24 }}>❯ 메시지를 보내 작업을 시작하세요.</Text> : null}
      renderItem={({ item }) => <TimelineRow entry={item} theme={theme} />} />
    {showLatest && <View style={{ position: "absolute", bottom: 12, right: 16, backgroundColor: color.surface2 }}>
      <Button label="↓ 최신 메시지" color={color.accent} onPress={() => { following.current = true; setShowLatest(false); list.current?.scrollToEnd({ animated: false }); }} />
    </View>}
  </View>;
});
