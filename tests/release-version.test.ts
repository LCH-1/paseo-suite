import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

test(
  "Windows 빌드의 중간 명령 실패는 뒤의 성공 명령으로 가려지지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    const workflow = await read(".github/workflows/windows-release.yml");
    const execute = promisify(execFile);
    for (const name of [
      "Core dependencies and patched runtime",
      "Desktop main",
      "Suite verification and package",
    ]) {
      const step = workflow
        .split("      - name: ")
        .find(
          (section) =>
            section.startsWith(name + "\n") ||
            section.startsWith(name + "\r\n"),
        );
      assert.ok(step, `Missing Windows build step: ${name}`);
      const body = step.match(
        /        run: \|\r?\n((?:          .*\r?\n)+)/,
      )?.[1];
      assert.ok(body, `Missing build script: ${name}`);
      const lines = body.split(/\r?\n/).map((line) => line.trim());
      const firstCommand = lines.findIndex((line) =>
        /^(?:npm|npx|git)\b/.test(line),
      );
      assert.ok(firstCommand >= 0, `Missing native command: ${name}`);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        ...lines.slice(0, firstCommand),
        '& node -e "process.exit(17)"',
        "Write-Output 'CONTINUED_AFTER_FAILURE'",
        '& node -e "process.exit(0)"',
        "exit $LASTEXITCODE",
      ].join("\n");
      await assert.rejects(
        execute(
          "pwsh",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { windowsHide: true, timeout: 10000 },
        ),
        (error: unknown) => {
          const failure = error as Error & { code: unknown; stdout: string };
          assert.equal(failure.code, 1, name);
          assert.doesNotMatch(failure.stdout, /CONTINUED_AFTER_FAILURE/, name);
          return true;
        },
      );
    }
  },
);

test("Windows 설치본은 검증된 Core의 보관 탭 연동과 사이드바 아이콘을 포함한다", async () => {
  const workflow = await read(".github/workflows/windows-release.yml");
  const ref = workflow.match(
    /repository: LCH-1\/paseo\s+ref: ([a-f0-9]{40})\b/,
  )?.[1];
  assert.ok(ref, "Core must be pinned to a complete immutable commit");
  const git = promisify(execFile);
  const coreFile = async (file: string) =>
    (
      await git(
        "git",
        [
          "-C",
          path.resolve(root, "../paseo-core"),
          "show",
          `${ref}:packages/app/src/${file}`,
        ],
        { windowsHide: true },
      )
    ).stdout;
  const archive = await coreFile("workspace/workspace-archive.ts");
  const presence = await coreFile("workspace-tabs/agent-tab-presence.ts");
  const icon = await coreFile("components/sidebar/sidebar-provider-icon.tsx");
  assert.match(
    archive,
    /agentTabPresenceBridge\.closeWorkspace\(input\.workspace\)/,
  );
  assert.match(presence, /closeWorkspace\(workspace: WorkspaceTabScope\)/);
  assert.match(icon, /export function SidebarProviderIcon/);
});

test("릴리스 버전은 패키지·잠금 파일·빌드 기록·설치 파일 이름에서 모두 같다", async () => {
  const { version } = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);

  const build = await read("tools/build.mjs");
  assert.equal(build.match(/suiteVersion: "([^"]+)"/)?.[1], version);

  // The updater compares this value, so a stale one hides the release from installed apps.
  const builder = await read("tools/electron-builder.cjs");
  assert.equal(
    builder.match(/extraMetadata: \{ version: "([^"]+)" \}/)?.[1],
    version,
  );
  const names = [...builder.matchAll(/Paseo-Suite-([\d.]+)-\$\{arch\}/g)].map(
    (match) => match[1],
  );
  assert.ok(names.length > 0);
  assert.deepEqual([...new Set(names)], [version]);
});
