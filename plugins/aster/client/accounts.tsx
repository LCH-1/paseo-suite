import { useEffect, useState } from "react";
import {
  useRpc,
  type PluginClientContext,
  type PluginSettingsScreenContribution,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { accountsRpc } from "../shared/accounts-rpc";
import type { z } from "zod";

function Accounts({ host, navigation }: PluginSurfaceProps) {
  const status = useRpc(accountsRpc.status),
    add = useRpc(accountsRpc.add),
    relogin = useRpc(accountsRpc.relogin);
  const [state, setState] = useState<z.output<
    typeof accountsRpc.status.output
  > | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false,
      running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const value = await status({});
        if (!stopped) {
          setState(value);
          setError(null);
        }
      } catch (error) {
        if (!stopped)
          setError(
            error instanceof Error
              ? error.message
              : "계정 상태를 읽지 못했습니다.",
          );
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [status, host.id]);
  const openLogin = async (
    start: () => Promise<{ workspaceId: string; terminalId?: string }>,
  ) => {
    setBusy(true);
    try {
      const flow = await start();
      const destination = {
        workspaceId: flow.workspaceId,
        serverId: host.id,
        terminalId: flow.terminalId,
      };
      navigation?.openWorkspace(destination);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "로그인을 시작하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  const login = (base: "claude" | "codex") => openLogin(() => add({ base }));
  return (
    <>
      <SettingsSection title="Claude · Codex 자동 계정 분배">
        <SettingsRow
          label={host.label}
          hint="구독이 유효한 계정의 잔여 한도와 동시 실행 수를 비교합니다. 구독 종료·한도 소진 계정은 자동 제외하고 다시 이용 가능해지면 복귀합니다. 실행 중인 요청은 계정을 바꾸지 않습니다."
          error={error}
        />
        {!state && !error && <SettingsRow label="계정과 구독 상태 확인 중…" />}
        {state?.accounts.map((account) =>
          account.canRelogin ? (
            <SettingsAction
              key={`${account.base}:${account.id}`}
              label={`Claude · ${account.label}`}
              hint={account.status}
              actionLabel="다시 로그인"
              disabled={busy}
              onPress={() => {
                void openLogin(() => relogin({ accountId: account.id }));
              }}
            />
          ) : (
            <SettingsRow
              key={`${account.base}:${account.id}`}
              label={`${account.base === "claude" ? "Claude" : "Codex"} · ${account.label}`}
              hint={account.status}
            />
          ),
        )}
      </SettingsSection>
      <SettingsSection title="계정 추가">
        <SettingsAction
          label="Claude 계정"
          hint="별도 인증 폴더에서 공식 CLI로 로그인합니다. 기존 대화 기록은 공유됩니다."
          actionLabel="계정 추가"
          disabled={busy}
          onPress={() => {
            void login("claude");
          }}
        />
        <SettingsAction
          label="Codex 계정"
          hint="공식 기기 코드로 로그인합니다. 기존 계정과 대화 저장 위치를 유지합니다."
          actionLabel="계정 추가"
          disabled={busy}
          onPress={() => {
            void login("codex");
          }}
        />
        {state?.flows.map((flow) => (
          <SettingsRow key={flow.id} label={flow.label} hint={flow.status} />
        ))}
      </SettingsSection>
    </>
  );
}

export function contributeAccounts(client: PluginClientContext) {
  const screen: PluginSettingsScreenContribution & { showInSettingsSidebar: boolean } = {
    id: "accounts",
    title: "AI 계정 자동 분배",
    icon: "Users",
    showInSettingsSidebar: true,
    Component: (props) => <Accounts key={props.host.id} {...props} />,
  };
  return client.addSettingsScreen(screen);
}
