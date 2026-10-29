import { useState } from "react";
import { Platform, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { ExternalLink, SettingsAction, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { ubuntuInstall, windowsInstall } from "./install-commands";

const steps = [
  {
    title: "1. Ubuntu 호스트 준비",
    hint: "연결하려는 Ubuntu의 터미널 또는 SSH에서 실행하세요. Paseo 0.12가 필요합니다. 키를 계속 보관하려면 libsecret-tools와 잠금 해제된 사용자 로그인 키링이 필요합니다. SSH 전용 서버에 키링이 없다면 화면의 수동 연결만 사용할 수 있습니다.",
    command: "sudo apt update\nsudo apt install -y gh unzip python3 libsecret-tools\npaseo --version",
  },
  {
    title: "2. GitHub 로그인",
    hint: "표시된 코드를 다른 PC나 휴대폰의 github.com/login/device에서 승인할 수 있습니다. 코드 저장소가 비공개이므로 LCH-1 또는 접근 권한이 있는 계정이 필요합니다.",
    command: "gh auth login --hostname github.com --web --git-protocol https --skip-ssh-key\ngh auth status",
  },
  {
    title: "3. 플러그인 실행 허용",
    hint: "아직 로컬 호스트가 실행 중이지 않을 때만 paseo start를 실행하세요. 아래 설치·업데이트 명령은 신뢰한 플러그인의 실행을 허용하고 Settings Sync를 활성화합니다. 전체 데몬을 재시작하지 않습니다.",
    command: "paseo status\n# 실행 중인 로컬 호스트가 없을 때만:\npaseo start",
  },
  {
    title: "4. Settings Sync 설치",
    hint: "GitHub 최신 릴리즈를 새 폴더로 받아 검증하고 활성화합니다. 설치기가 버전 하향을 막고, 업데이트 전 코드를 보존해 실패하면 복구합니다. Python 3 표준 라이브러리만 설치 검사에 사용하며 Git·pnpm·Node 패키지는 필요 없습니다.",
    command: ubuntuInstall,
  },
  {
    title: "5. 앱·웹에 Ubuntu 호스트 연결",
    hint: "출력된 연결 링크나 QR로 다른 PC의 Paseo 앱·웹에 Ubuntu 호스트를 추가하세요. 원격 연결을 위해 relay 허용을 묻는 경우 안내에 따라 선택합니다. 연결 링크는 다른 사람에게 공유하지 마세요.",
    command: "paseo pair",
  },
];

const windowsSteps = [
  {
    title: "1. 새 Windows PC 준비",
    hint: "Paseo 0.12와 CLI를 먼저 설치하세요. 아래 명령은 새 PC의 PowerShell에서 실행합니다. Git·pnpm·Node.js는 필요 없습니다. GitHub CLI 설치 후 PowerShell과 Paseo를 완전히 종료하고 다시 실행하세요.",
    command: "winget install --id GitHub.cli -e --source winget",
  },
  {
    title: "2. GitHub 로그인",
    hint: "브라우저에서 표시된 코드를 승인하세요. 플러그인 코드 저장소가 비공개이므로 LCH-1 또는 접근 권한이 있는 계정으로 로그인해야 합니다. 개인 설정 백업은 로그인한 계정의 암호화된 Gist에 따로 저장됩니다.",
    command: "gh auth login --hostname github.com --web --git-protocol https --skip-ssh-key\ngh auth status",
  },
  {
    title: "3. Settings Sync 설치",
    hint: "새 PC의 Paseo 로컬 호스트를 실행해 두세요. 최신 GitHub 릴리즈를 새 폴더로 받아 SHA-256 검증 후 설치합니다. 업데이트할 때도 같은 명령입니다. 마지막 status가 running인지 확인하세요.",
    command: windowsInstall,
  },
];

export function TerminalGuide({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const [open, setOpen] = useState<"windows" | "ubuntu" | null>(null);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const colors = theme.colors;
  async function copy(label: string, value: string) {
    setError("");
    try { await copyText(value); setCopied(label); }
    catch { setError("복사하지 못했습니다. 명령을 선택해 직접 복사하세요."); }
  }
  function command(label: string, value: string) {
    return <View style={{ gap: 8 }}>
      <Text selectable style={{ color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 20 }}>{value}</Text>
      <SettingsAction label={label} actionLabel={copied === label ? "복사됨" : "명령 복사"} onPress={() => void copy(label, value)} />
    </View>;
  }
  return <View style={{ gap: 16 }}>
    <SettingsAction label="다른 Windows PC에 설치하고 복원하기" hint="PowerShell 명령부터 GitHub 로그인, 설정·플러그인 복원까지" actionLabel={open === "windows" ? "접기" : "가이드 보기"} onPress={() => setOpen(open === "windows" ? null : "windows")} />
    {open === "windows" && <>
      <SettingsRow label="기존 PC에서 먼저 자동 동기화를 연결하세요" hint="첫 백업이 완료되어야 새 PC로 가져올 수 있습니다. 다른 기기에서도 같은 백업 암호를 처음 한 번 입력하므로 따로 보관하세요. 이전 수동 백업도 그대로 읽습니다." />
      {windowsSteps.map((step) => <SettingsSection key={step.title} title={step.title}>
        <SettingsRow label={step.hint} />
        {command(`${step.title} 명령`, step.command)}
      </SettingsSection>)}
      <SettingsSection title="4. 저장된 환경 복원">
        <SettingsRow label="새 PC의 로컬 호스트에서 Settings Sync를 여세요" hint="사이드바 구름 아이콘 또는 설정 → 플러그인 → Settings Sync로 들어갑니다. 원격 호스트를 선택하면 서버 설정·플러그인은 그 원격 호스트에 적용되므로 복원 대상을 확인하세요." />
        <SettingsRow label="같은 GitHub 계정과 백업 암호로 연결하세요" hint="GitHub으로 로그인 → 기존과 동일한 백업 암호 → 자동 동기화 시작. 기존 백업을 먼저 복원하고 이후 변경을 30초마다 확인합니다. 화면을 나갔다 돌아와도 유지되고 앱 재시작 후 자동 연결됩니다. 저장소나 Gist ID 입력은 없습니다." />
        <SettingsRow label="호스트·테마는 복원 완료 후 창이 자동 새로고침됩니다" hint="설정 화면을 닫아도 동기화 완료 후 현재 창을 한 번 새로고침합니다. 기존 PC의 localhost 주소는 제외하며 원래 PC에 접속하려면 paseo pair로 원격 연결을 추가하세요. 지원하는 Claude·Codex·Cursor 계정 인증도 암호화해 복원합니다. SSH 개인키나 만료·철회된 인증은 별도 연결이 필요합니다." />
      </SettingsSection>
      <SettingsSection title="Windows 업데이트와 문제 확인">
        {command("Windows 확장 업데이트", windowsInstall)}
        {command("Windows 설치·연결 상태 확인", "paseo status\npaseo plugin ls settings-sync\npaseo plugin logs settings-sync")}
        <SettingsRow label="명령을 찾지 못하거나 사이드바에 안 보이는 경우" hint="paseo 명령이 없다면 Paseo CLI 설치와 PATH를 확인하세요. gh 설치 직후에는 PowerShell과 Paseo를 완전히 종료한 뒤 다시 실행하세요. 로컬 호스트의 플러그인 허용과 running 상태를 확인한 뒤 설정 화면을 다시 여세요. 사용자 지정 PASEO_HOME은 설치·실행 시 동일하게 사용해야 합니다." />
        <SettingsRow label="disabled이거나 의존성을 찾지 못하는 경우" hint="ENABLED yes여도 STATUS disabled면 호스트의 전역 플러그인 허용을 확인하세요. 이전 버전의 타입·패키지 의존성 오류는 0.1.1 이상으로 업데이트하세요. ZIP 설치는 새 배포본을 별도 폴더에 풀고 그 폴더를 다시 설치하면 됩니다. 패키지 설치는 필요 없습니다." />
        {command("Windows 실행 허용과 재로드", "paseo daemon config set pluginsEnabled true\npaseo plugin enable settings-sync\npaseo plugin ls settings-sync")}
        <ExternalLink href="https://paseo.sh/docs"><Text style={{ color: colors.accent }}>Paseo 설치 안내</Text></ExternalLink>
        <ExternalLink href="https://cli.github.com/"><Text style={{ color: colors.accent }}>GitHub CLI 설치 안내</Text></ExternalLink>
      </SettingsSection>
    </>}
    <SettingsAction label="Ubuntu·SSH 터미널에서 설치하고 연결하기" hint="GitHub 로그인부터 플러그인 설치, 호스트 연결과 복원까지" actionLabel={open === "ubuntu" ? "접기" : "가이드 보기"} onPress={() => setOpen(open === "ubuntu" ? null : "ubuntu")} />
    {open === "ubuntu" && <>
      {steps.map((step) => <SettingsSection key={step.title} title={step.title}>
        <SettingsRow label={step.hint} />
        {command(`${step.title} 명령`, step.command)}
      </SettingsSection>)}
      <SettingsSection title="6. 저장된 환경 복원">
        <SettingsRow label="앱·웹에서 Ubuntu 호스트를 선택하세요" hint="Settings Sync → GitHub으로 로그인 → 기존 백업과 같은 암호 → 자동 동기화 시작. 백업한 계정으로 로그인해야 합니다. 잠금 해제된 OS 키링이 필요하며 연결 실패 시 수동 미리보기·복원을 사용할 수 있습니다." />
        <SettingsRow label="SSH 터미널만으로 백업·복원하는 명령은 아직 없습니다" hint="설치와 GitHub 인증은 터미널에서 하고, 백업·복원은 Ubuntu 호스트에 연결한 데스크톱·웹 화면에서 진행합니다. 서버 설정·플러그인은 선택한 Ubuntu에, 화면·호스트 목록은 접속한 앱·브라우저에 적용됩니다." />
        <SettingsRow label="기기별 경로와 계정 로그인 확인" hint="프로바이더 실행 파일과 지원하는 계정 인증은 Ubuntu 경로로 복원하며, 표준 Claude·Codex·Cursor CLI가 없으면 자동 준비합니다. SSH 개인키·지원하지 않는 저장소·만료 또는 철회된 인증은 별도로 연결해야 합니다." />
      </SettingsSection>
      <SettingsSection title="업데이트와 문제 확인">
        {command("설치한 확장 업데이트", ubuntuInstall)}
        {command("설치·연결 상태 확인", "paseo status\npaseo plugin ls settings-sync\npaseo plugin logs settings-sync")}
        <SettingsRow label="사이드바에 안 보이는 경우" hint="Ubuntu 호스트를 보고 있는지, 플러그인 상태가 running인지 확인하고 Settings Sync 화면을 다시 여세요. 사용자 지정 PASEO_HOME을 쓰면 설치·실행·연결에서도 같은 홈을 사용해야 합니다." />
        <ExternalLink href="https://paseo.sh/docs"><Text style={{ color: colors.accent }}>Paseo 설치 안내</Text></ExternalLink>
        <ExternalLink href="https://cli.github.com/"><Text style={{ color: colors.accent }}>GitHub CLI 설치 안내</Text></ExternalLink>
      </SettingsSection>
    </>}
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text>}
  </View>;
}
