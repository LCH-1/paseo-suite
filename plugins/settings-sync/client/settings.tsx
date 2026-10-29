import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { openExternalUrl, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { rpc, type ConnectionState, type Summary } from "../shared/rpc";
import { browserStorage, capture } from "./storage";
import { TerminalGuide } from "./terminal-guide";
import { sessionMemory, type LoginFlow, type PendingManualRestore } from "./session";
import { manualRpc } from "../shared/manual-restore-rpc";
import { finishManualRestore } from "./manual-restore";
import type { AutoClient } from "./automation";
import { normalizeScopes, offStatus, stableString, type AutoScopes } from "../shared/automation";

type SyncProps = PluginSurfaceProps & { automation: AutoClient };
export function SyncSettings(props: SyncProps) {
  return <HostSyncSettings key={props.host.id} {...props} />;
}

function HostSyncSettings({ theme, host, automation }: SyncProps) {
  const automatic = useSyncExternalStore(automation.subscribe, automation.getSnapshot, automation.getSnapshot);
  const startLogin = useRpc(rpc.startLogin);
  const pollLogin = useRpc(rpc.pollLogin);
  const cancelLogin = useRpc(rpc.cancelLogin);
  const connect = useRpc(rpc.connect);
  const resume = useRpc(rpc.resume);
  const disconnect = useRpc(rpc.disconnect);
  const push = useRpc(rpc.push);
  const preview = useRpc(rpc.preview);
  const restoreStart = useRpc(manualRpc.restoreStart);
  const restoreStatus = useRpc(manualRpc.restoreStatus);
  const restoreRelease = useRpc(manualRpc.restoreRelease);
  const [initial] = useState(() => sessionMemory.read(host.id));
  const [password, setPassword] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<AutoScopes>(() => ({ ...(initial?.pending?.scopes ?? offStatus.scopes) }));
  const [flow, setFlow] = useState<LoginFlow | null>(initial?.flow ?? null);
  const [connection, setConnection] = useState<ConnectionState | null>(initial?.connection ?? null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [clientBefore, setClientBefore] = useState("");
  const [previewScopes, setPreviewScopes] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [working, setBusy] = useState(Boolean(initial?.connection));
  const [pending, setPending] = useState<PendingManualRestore | null>(initial?.pending ?? null);
  const busy = working || automatic.busy || automatic.loading || Boolean(pending);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const flowRef = useRef<string | null>(initial?.flow?.flowId ?? null);
  const alive = useRef(true);
  const workRef = useRef(false);
  const scopeDraft = useRef(false);
  const manualTurn = useRef(0);
  const foreground = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const supported = typeof globalThis.localStorage !== "undefined";
  const savedScopes = stableString(automatic.status.scopes);
  const selectedSignature = stableString(selectedScopes);
  const hasSelectedScopes = Object.values(selectedScopes).some(Boolean);

  useEffect(() => {
    if (!automatic.loading && automatic.status.enabled && !scopeDraft.current) setSelectedScopes(normalizeScopes(automatic.status.scopes));
  }, [automatic.loading, automatic.status.enabled, savedScopes]);

  useEffect(() => { setSummary(null); setOverwrite(false); }, [selectedSignature]);

  useEffect(() => {
    alive.current = true;
    let canceled = false;
    if (initial?.connection) {
      setBusy(true);
      if (initial.pending) void continueRestore();
      else void resume({ sessionId: initial.connection.sessionId }).then((result) => {
        if (result) sessionMemory.connection(host.id, result);
        else sessionMemory.forget(host.id);
        if (!canceled) { setConnection(result); if (!result) setNotice("연결이 만료되었습니다. GitHub 로그인과 백업 암호로 다시 연결하세요."); }
      }).catch((reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : "연결 상태를 확인하지 못했습니다.");
      }).finally(() => { if (!canceled) setBusy(false); });
    }
    return () => { canceled = true; alive.current = false; manualTurn.current++; };
  }, [initial, host.id, resume, restoreStart, restoreStatus, restoreRelease]);

  useEffect(() => {
    if (!flow || flow.ready) return;
    let canceled = false;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      if (Date.now() > flow.expires) {
        clearInterval(timer); sessionMemory.forget(host.id); setFlow(null); setError("GitHub 로그인 코드가 만료되었습니다."); return;
      }
      pending = true;
      void pollLogin({ flowId: flow.flowId }).then((result) => {
        if (!canceled && result.ready) {
          const next = { ...flow, ready: true, login: result.login };
          sessionMemory.flow(host.id, next); setFlow(next);
        }
      }).catch((reason: unknown) => {
        if (!canceled) { clearInterval(timer); sessionMemory.forget(host.id); setError(reason instanceof Error ? reason.message : "로그인 상태를 확인하지 못했습니다."); setFlow(null); }
      }).finally(() => { pending = false; });
    }, 5000);
    return () => { canceled = true; clearInterval(timer); };
  }, [flow, pollLogin, host.id]);

  async function run(work: () => Promise<void>, allowPending = false) {
    if (working || automatic.busy || automatic.loading || pending && !allowPending || workRef.current) return;
    workRef.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "작업을 완료하지 못했습니다."); }
    finally { workRef.current = false; if (alive.current) setBusy(false); }
  }

  function editScope(key: keyof AutoScopes, value: boolean) {
    scopeDraft.current = true;
    setSelectedScopes((current) => ({ ...current, [key]: value }));
  }

  async function saveScopes() {
    await automation.configure(selectedScopes, !automatic.owned);
    if (!alive.current) return;
    scopeDraft.current = false;
    setSelectedScopes(normalizeScopes(automation.getSnapshot().status.scopes));
    setNotice("이 앱에서 사용할 동기화 범위를 저장했습니다.");
  }

  async function signIn(force = false) {
    if (flowRef.current) await cancelLogin({ flowId: flowRef.current });
    const result = await startLogin({ force });
    const next = { ...result, expires: Date.now() + result.expiresIn * 1000 };
    sessionMemory.flow(host.id, next);
    if (!alive.current) return;
    flowRef.current = result.flowId;
    setFlow(next);
    if (result.url && !result.ready) await openExternalUrl(result.url);
  }

  async function unlock() {
    if (!flow?.ready) return;
    const result = await connect({ flowId: flow.flowId, password });
    sessionMemory.connection(host.id, result);
    if (!alive.current) return;
    flowRef.current = null;
    setConnection(result); setPassword(""); setFlow(null); setOverwrite(false);
    await automation.enable(result.sessionId, selectedScopes);
    sessionMemory.forget(host.id);
    if (!alive.current) return;
    setConnection(null);
    setNotice("자동 동기화를 연결했습니다. 이후 변경도 자동으로 처리합니다.");
  }

  async function refreshBackup() {
    if (!connection) return;
    const result = await resume({ sessionId: connection.sessionId });
    if (result) sessionMemory.connection(host.id, result); else sessionMemory.forget(host.id);
    setConnection(result); setSummary(null); setOverwrite(false);
    setNotice(!result ? "연결이 만료되었습니다. 다시 연결하세요." : result.hasBackup ? "저장된 백업을 찾았습니다. 미리보기를 열어 복원하세요." : "아직 백업이 없습니다. 기존 PC에서 같은 GitHub 계정으로 백업을 올린 뒤 다시 찾기를 누르세요.");
  }

  async function loadPreview() {
    if (!connection) return;
    const result = await preview({ sessionId: connection.sessionId, scopes: selectedScopes });
    const next = { ...connection, hasBackup: true, createdAt: result.createdAt };
    sessionMemory.connection(host.id, next); setConnection(next);
    setClientBefore(stableString(capture(browserStorage(), selectedScopes)));
    setPreviewScopes(selectedSignature);
    setSummary(result); setOverwrite(false);
  }

  async function upload() {
    if (!connection) return;
    const result = await push({ sessionId: connection.sessionId, client: capture(browserStorage(), selectedScopes), scopes: selectedScopes });
    const next = { ...connection, hasBackup: true, createdAt: result.createdAt };
    sessionMemory.connection(host.id, next); setConnection(next);
    setSummary(null); setOverwrite(false);
    setNotice(`암호화 백업 완료 · 원격 호스트 ${result.hosts}개 · 프로바이더 ${result.providers}개 · 계정 인증 ${result.authentications}개 · 플러그인 ${result.plugins}개`);
  }

  async function continueRestore() {
    const turn = ++manualTurn.current;
    const active = () => alive.current && manualTurn.current === turn;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await finishManualRestore({ host: host.id, memory: sessionMemory, storage: browserStorage(), active, calls: { start: restoreStart, status: restoreStatus, release: restoreRelease } });
      if (active() && result) {
        setPending(null); setSummary(null);
        setNotice(`복원했습니다. 호스트 목록과 화면 설정 반영을 위해 Paseo 창을 다시 여세요. 이전 서버 설정: ${result.backupDirectory}`);
      }
    } catch (reason) {
      if (active()) {
        const next = sessionMemory.read(host.id)?.pending ?? null;
        setPending(next);
        if (!next) setSummary(null);
        setError(reason instanceof Error ? reason.message : "복원 상태를 확인하지 못했습니다. 이어받기로 다시 확인하세요.");
      }
    } finally { if (active()) setBusy(false); }
  }

  async function resetManualConnection() {
    const sessionId = connection?.sessionId;
    sessionMemory.forget(host.id);
    setPending(null); setConnection(null); setSummary(null); setPassword(""); setFlow(null);
    if (sessionId) await disconnect({ sessionId });
  }

  async function download() {
    if (!connection || !summary) return;
    if (selectedSignature !== previewScopes) throw new Error("미리보기 이후 동기화 항목이 바뀌었습니다. 다시 미리보기를 여세요.");
    const storage = browserStorage();
    if (stableString(capture(storage, selectedScopes)) !== clientBefore) throw new Error("미리보기 이후 앱 설정이 바뀌었습니다. 다시 미리보기를 여세요.");
    const next: PendingManualRestore = { input: { sessionId: connection.sessionId, previewId: summary.id, plugins: selectedScopes.plugins, config: selectedScopes.config, scopes: selectedScopes }, scopes: { ...selectedScopes }, before: clientBefore, phase: "server" };
    sessionMemory.pending(host.id, next); setPending(next);
    await continueRestore();
  }

  return <View style={{ gap: 20 }}>
    <Text style={{ color: foreground, fontSize: 16 }}>다른 기기에서도 같은 호스트, 화면 설정과 플러그인을 사용하세요.</Text>
    {!supported && <Text style={{ color: muted }}>호스트·앱 설정의 백업과 복원은 현재 Paseo 데스크톱과 웹에서 지원합니다.</Text>}
    <TerminalGuide theme={theme} />
    <SettingsSection title="동기화 항목">
      <SettingsRow label="이 PC의 현재 호스트에 적용" hint="선택한 항목만 자동·수동 백업과 복원에 사용합니다. 선택하지 않은 항목은 이 PC의 값을 유지합니다. 다른 PC의 선택에는 영향을 주지 않습니다." />
      {automatic.status.enabled && !automatic.owned && <SettingsRow label="현재 앱은 동기화 상태만 확인합니다" hint="항목을 눌러 초안을 편집할 수 있습니다. 아래 ‘이 앱에서 담당하고 범위 적용’을 누를 때만 이 앱으로 인계하고 선택을 저장합니다." />}
      <SettingsSwitch label="원격 호스트" hint="다른 PC에서도 접속할 수 있는 호스트 연결정보와 접속 암호. localhost·로컬 소켓·파이프 연결은 제외합니다." value={selectedScopes.hosts} onValueChange={(value) => editScope("hosts", value)} disabled={working || automatic.loading} />
      <SettingsSwitch label="앱 설정" hint="테마·단축키·에이전트 생성 기본값·기본 편집기·변경 보기 설정." value={selectedScopes.preferences} onValueChange={(value) => editScope("preferences", value)} disabled={working || automatic.loading} />
      <SettingsSwitch label="프로바이더와 계정" hint="프로바이더 구성·프로필·API 키와 지원하는 CLI 계정 인증을 함께 암호화해 동기화합니다. 실행·계정 경로는 이 PC에 맞춰 복원합니다." value={selectedScopes.providers} onValueChange={(value) => editScope("providers", value)} disabled={working || automatic.loading} />
      <SettingsSwitch label="서버 설정" hint="현재 호스트의 프롬프트·메타데이터 생성·터미널·에이전트 프로필과 지원되는 브라우저 도구·MCP 설정." value={selectedScopes.config} onValueChange={(value) => editScope("config", value)} disabled={working || automatic.loading} />
      <SettingsSwitch label="플러그인" hint="플러그인 코드·활성 상태·공식 설정. Settings Sync 자체와 플러그인이 임의 경로에 보관한 파일은 제외합니다." value={selectedScopes.plugins} onValueChange={(value) => editScope("plugins", value)} disabled={working || automatic.loading} />
      {automatic.status.enabled && automatic.status.pendingOperations !== 0 && <SettingsRow label={automatic.status.pendingOperations === null ? "저장된 동기화 연결을 확인하세요" : "진행 중인 복원을 먼저 완료하세요"} hint={automatic.status.pendingOperations === null ? automatic.status.message : "초안은 편집할 수 있습니다. 남은 복원이 끝난 뒤 담당 앱과 동기화 범위를 적용할 수 있습니다."} />}
      {automatic.status.enabled && !automatic.owned && (automatic.status.pendingOperations ?? 0) > 0 && <SettingsAction label="중단된 복원 이어받기" hint="기존에 시작한 범위로 복원을 먼저 마친 뒤 편집한 초안을 적용하세요." actionLabel="이 앱에서 복원 이어받기" disabled={busy} onPress={() => void run(() => automation.claim())} />}
      {automatic.status.enabled && <SettingsAction label="선택한 동기화 범위 저장" hint="해제한 항목은 더 전송하지 않습니다. 유지할 항목에 미전송 변경이나 진행 중인 복원이 있으면 먼저 동기화를 완료하세요. 새로 선택한 항목은 저장된 백업을 먼저 확인합니다." actionLabel={automatic.owned ? "범위 적용" : "이 앱에서 담당하고 범위 적용"} disabled={busy || automatic.status.pendingOperations !== 0 || (automatic.owned && selectedSignature === savedScopes)} onPress={() => void run(saveScopes)} />}
      <SettingsRow label="별도 연결이 필요한 항목" hint="SSH 개인키와 플러그인의 자체 저장 파일은 제외됩니다. 만료·철회된 계정 인증이나 지원하지 않는 OS 저장소는 별도 연결이 필요합니다." />
    </SettingsSection>
    {pending && <SettingsSection title="진행 중인 수동 복원">
      <SettingsRow label="복원 결과를 이어서 확인합니다" hint="화면을 나갔다 돌아와도 같은 작업의 결과를 조회합니다. 앱 설정 적용과 완료 확인이 끝나면 새 작업을 시작할 수 있습니다." />
      <SettingsAction label="같은 복원의 결과 다시 확인" actionLabel="복원 이어받기" disabled={working || automatic.busy || automatic.loading} onPress={() => void run(continueRestore, true)} />
      <SettingsAction label="복원 연결 다시 설정" hint="세션이 만료되었거나 호스트가 재시작됐을 때 사용하세요. 서버에 이미 적용한 설정은 유지됩니다." actionLabel="다시 연결" disabled={working || automatic.busy || automatic.loading} onPress={() => void run(resetManualConnection, true)} />
    </SettingsSection>}
    {automatic.loading ? <SettingsRow label="저장된 자동 동기화 연결을 확인하고 있습니다…" /> : automatic.status.enabled ? <>
      <SettingsSection title={`${automatic.status.login ?? "GitHub"} · 자동 동기화`}>
        {automatic.needsReload && <SettingsRow label="호스트·테마 적용 대기" hint="동기화가 끝나면 현재 화면과 관계없이 앱 창을 한 번 새로고침해 적용합니다." />}
        <SettingsRow label={!automatic.owned ? automatic.status.ownerClientId ? "다른 앱에서 동기화 담당" : "동기화 담당 앱 선택 필요" : automatic.status.state === "conflict" ? "동기화 충돌 확인 필요" : automatic.status.state === "locked" || automatic.status.state === "error" ? "동기화 연결 확인 필요" : "자동 동기화 사용 중"} hint={automatic.owned ? automatic.status.message : "현재 이 앱에서는 동기화 상태만 확인합니다. 이 호스트를 이 앱에서 동기화하려면 위의 범위 적용 버튼으로 담당 앱을 지정하세요."} />
        <SettingsRow label="마지막 동기화" hint={automatic.status.lastSyncedAt ?? "첫 동기화를 준비하고 있습니다."} />
        <SettingsRow label="동기화 범위" hint="위에서 선택한 항목을 변경 시 자동으로 동기화합니다. 서버·프로바이더·플러그인 설정은 현재 호스트에 적용하며 다른 원격 호스트 자체의 설정은 변경하지 않습니다. 설정 화면을 닫아도 앱이 실행 중이면 계속됩니다." />
        <SettingsRow label="플러그인 업데이트도 다른 PC로 전달" hint="설치한 플러그인의 코드·활성 상태·공식 설정이 바뀌면 같은 계정과 암호로 연결한 PC에도 자동 적용합니다. 오프라인 PC는 다음 앱 실행 때 받습니다. Settings Sync 자체는 최신 릴리즈로 따로 업데이트하세요." />
        <SettingsRow label="가져올 수 있는 호스트" hint="다른 PC에서도 접속 가능한 relay·원격 TCP·SSH 연결을 가져옵니다. 기존 PC의 localhost 연결은 새 PC에서 원래 PC를 가리키지 않으므로 제외합니다. 원래 PC에도 원격 접속하려면 그 PC의 paseo pair로 연결을 등록하세요." />
        <SettingsRow label="이 PC에서 로그인 유지" hint="백업 키는 OS 보안 저장소에 보관합니다. 앱을 다시 켜도 자동 연결됩니다. 다른 PC에서는 처음 한 번 같은 백업 암호로 연결하세요. 호스트·테마가 바뀌면 동기화를 마친 뒤 현재 화면과 관계없이 앱 창을 한 번 새로고침해 반영합니다." />
        {automatic.owned && (automatic.status.state === "conflict" ? <>
          <SettingsAction label="이 PC의 현재 환경으로 충돌 해결" hint="현재 환경을 새 암호화 백업으로 저장합니다. 이전 백업은 보존됩니다." actionLabel="이 PC 사용" disabled={busy} onPress={() => void run(() => automation.synchronize("local"))} />
          <SettingsAction label="클라우드의 환경으로 충돌 해결" hint="저장된 환경을 이 PC에 다시 적용합니다." actionLabel="클라우드 사용" disabled={busy} onPress={() => void run(() => automation.synchronize("remote"))} />
        </> : <SettingsAction label="자동 동기화 상태 확인" actionLabel="지금 동기화" disabled={busy} onPress={() => void run(() => automation.synchronize())} />)}
        <SettingsAction label="자동 동기화를 끄고 보관한 키 지우기" actionLabel="연결 해제" disabled={busy} onPress={() => void run(async () => { await automation.disable(); sessionMemory.forget(host.id); setConnection(null); setFlow(null); setPassword(""); })} />
      </SettingsSection>
    </> : !connection ? <>
      <SettingsSection title="GitHub 로그인">
        <SettingsAction label="GitHub 계정으로 설정 동기화" hint="로그인하면 이 계정의 동기화 Gist를 자동으로 찾습니다. 저장소나 앱 등록은 필요 없습니다." actionLabel={flow?.ready ? "로그인됨" : "GitHub으로 로그인"} disabled={busy || Boolean(flow?.ready)} onPress={() => void run(() => signIn())} />
        {flow && <SettingsRow label={flow.ready ? `${flow.login} 계정으로 로그인됨` : `인증 코드: ${flow.code}`} hint={flow.ready ? "아래에서 백업 잠금을 해제하세요." : `${flow.url} 에서 코드를 입력하세요.`} />}
        {flow && <SettingsAction label={flow.ready ? "다른 GitHub 계정 사용" : "로그인 다시 시작"} actionLabel="계정 변경" disabled={busy} onPress={() => void run(() => signIn(true))} />}
      </SettingsSection>
      {flow?.ready && <SettingsSection title="백업 잠금 해제">
        <SettingsInput label="백업 암호" hint="첫 PC에서는 12자 이상의 암호를 정하고 다른 PC에서는 같은 암호를 입력하세요. 키는 이 PC의 OS 보안 저장소에 보관해 재시작 후 자동 연결합니다. Gist에는 키·암호를 저장하지 않으며 분실하면 복구할 수 없습니다." secureTextEntry initialValue={password} onChangeText={setPassword} disabled={busy} />
        <SettingsAction label="기존 백업을 자동 복원하고 이후 변경을 자동 백업" hint="호스트·앱·프로바이더 설정과 신뢰한 계정의 플러그인 코드·설정을 자동으로 적용합니다. 호스트·테마가 바뀌면 동기화 완료 후 앱 창을 한 번 새로고침합니다. 처음 연결한 기기에서만 암호를 입력하면 됩니다." actionLabel="자동 동기화 시작" disabled={busy || password.length < 12} onPress={() => void run(unlock)} />
      </SettingsSection>}
    </> : <>
      <SettingsSection title={`${connection.login} · GitHub Gist 동기화`}>
        <SettingsAction label="이 연결을 유지하고 백업·복원을 자동으로 진행" hint="OS 보안 저장소에 키를 보관하고 위에서 선택한 항목의 변경을 동기화합니다." actionLabel="자동 동기화 시작" disabled={busy} onPress={() => void run(async () => { await automation.enable(connection.sessionId, selectedScopes); sessionMemory.forget(host.id); setConnection(null); })} />
        <SettingsRow label="동기화 범위" hint="위에서 선택한 항목만 백업·복원합니다. 서버·프로바이더·플러그인 설정은 현재 호스트에 적용하며 다른 원격 호스트 자체의 설정은 변경하지 않습니다." />
        <SettingsRow label={connection.hasBackup ? "저장된 백업이 있습니다" : "이 계정에 저장된 백업이 없습니다"} hint={connection.hasBackup ? `백업 시각: ${connection.createdAt}. 로그인만으로 복원되지는 않습니다. 미리보기에서 복원 범위를 선택하세요.` : "기존 환경이 있는 PC에서 같은 GitHub 계정으로 로그인하고 백업 올리기를 완료한 뒤, 여기서 백업 다시 찾기를 누르세요."} />
        <SettingsAction label="GitHub의 백업 상태 새로고침" actionLabel="백업 다시 찾기" disabled={busy} onPress={() => void run(refreshBackup)} />
        {connection.hasBackup && <SettingsSwitch label="기존 백업 교체" hint={`백업 시각: ${connection.createdAt}. 현재 기기의 환경으로 교체하려면 켜세요.`} value={overwrite} onValueChange={setOverwrite} disabled={busy} />}
        <SettingsAction label="현재 환경을 Gist에 저장" hint="선택한 항목을 암호화해 Secret Gist로 보관합니다. 이전 백업도 유지합니다." actionLabel="백업 올리기" disabled={busy || !supported || !hasSelectedScopes || (connection.hasBackup && !overwrite)} onPress={() => void run(upload)} />
        <SettingsAction label="저장된 환경 확인" actionLabel="미리보기" disabled={busy || !supported || !hasSelectedScopes || !connection.hasBackup} onPress={() => void run(loadPreview)} />
      </SettingsSection>
      {summary && <SettingsSection title="복원 미리보기">
        <SettingsRow label={`${summary.device} · ${summary.createdAt}`} hint={`호스트: ${summary.hosts.join(", ") || "없음"}`} />
        <SettingsRow label="프로바이더와 계정" hint={`프로바이더: ${summary.providers.join(", ") || "없음"}. 인증 백업 포함: ${summary.authenticatedProviders.join(", ") || "없음 — 인증이 없는 이전 백업은 원본 PC에서 새로 동기화하세요."}`} />
        <SettingsRow label="플러그인" hint={summary.plugins.map((p) => `${p.id} (${p.files}개 파일, ${p.enabled ? "활성" : "비활성"}, 설정 ${p.settings.length}개)`).join("\n") || "없음"} />
        <SettingsAction label="선택한 항목 적용" hint="위에서 선택한 범위를 복원합니다. 플러그인은 신뢰하는 코드만 적용하세요. 현재 기기에만 있는 호스트와 플러그인은 유지하며 서버의 이전 설정은 로컬에 보관합니다." actionLabel="복원" disabled={busy || !hasSelectedScopes} onPress={() => void run(download)} />
      </SettingsSection>}
      <SettingsAction label="GitHub 연결과 복구 암호 지우기" actionLabel="연결 해제" disabled={busy} onPress={() => void run(async () => {
        await disconnect({ sessionId: connection.sessionId }); sessionMemory.forget(host.id); setConnection(null); setSummary(null); setPassword("");
      })} />
    </>}
    {busy && <Text style={{ color: muted }}>처리 중…</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: foreground }}>{error}</Text>}
    {!!notice && <Text style={{ color: foreground }}>{notice}</Text>}
  </View>;
}
