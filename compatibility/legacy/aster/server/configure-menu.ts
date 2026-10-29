import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Script } from "node:vm";
import { paseoHome, readSettings, stateDirectory } from "./accounts.ts";
import { patchClaudeMenu, singleClaudePresentation } from "./menu.ts";
import { runPaseo } from "./paseo.ts";

const settings = await readSettings();
const signal = AbortSignal.timeout(60_000);
const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf8"));
const presentation = singleClaudePresentation(config.daemon.agentProfiles ?? [], config.agents.providers);
const resources = process.env.PASEO_RESOURCES_DIR ?? join(process.env.ProgramFiles ?? "C:\\Program Files", "Paseo", "resources");
const webDirectory = join(resources, "app-dist", "_expo", "static", "js", "web");
const candidates = (await readdir(webDirectory)).filter((file) => /^index-.*\.js$/.test(file));
if (candidates.length !== 1) throw new Error("Paseo 앱 번들을 하나로 특정할 수 없습니다.");
const bundlePath = join(webDirectory, candidates[0]);
const original = await readFile(bundlePath, "utf8");
const patched = patchClaudeMenu(original);
new Script(patched, { filename: candidates[0] });
if (patched !== original) {
  await writeFile(join(stateDirectory, "claude-menu-original.js"), original, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}
const patchedPath = join(stateDirectory, "claude-menu-patched.js");
await writeFile(patchedPath, patched);
const hash = (value: string) => createHash("sha256").update(value).digest("hex").toUpperCase();
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const resultPath = join(stateDirectory, "claude-menu-install-result.json");
const installerPath = join(stateDirectory, "install-claude-menu.ps1");
const installer = [
  '$ErrorActionPreference = "Stop"',
  `$target = ${literal(bundlePath)}`,
  `$source = ${literal(patchedPath)}`,
  `$resultFile = ${literal(resultPath)}`,
  "try {",
  `  if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne '${hash(patched)}') { throw '변경 파일 해시 불일치' }`,
  "  $currentHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash",
  `  if ($currentHash -ne '${hash(original)}' -and $currentHash -ne '${hash(patched)}') { throw '설치 앱 버전이 변경되어 적용 중단' }`,
  `  if ($currentHash -ne '${hash(patched)}') { Copy-Item -LiteralPath $source -Destination $target -Force }`,
  '  @{ success = $true } | ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8',
  "} catch {",
  '  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8',
  "  exit 1",
  "}",
].join("\r\n");
await writeFile(installerPath, "\uFEFF" + installer);
await writeFile(join(stateDirectory, "claude-presentation-original.json"), JSON.stringify({
  profiles: config.daemon.agentProfiles ?? [],
  labels: presentation.labels.map(({ id }) => ({ id, label: config.agents.providers[id].label })),
}, null, 2) + "\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST") throw error;
});
await runPaseo(settings.command, ["daemon", "config", "set", "daemon.agentProfiles", JSON.stringify(presentation.profiles), "--home", paseoHome], signal);
const latestConfig = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf8"));
for (const { id, label } of presentation.labels) latestConfig.agents.providers[id].label = label;
await runPaseo(settings.command, ["daemon", "config", "set", "agents.providers", JSON.stringify(latestConfig.agents.providers), "--home", paseoHome], signal);
console.log("Claude 프로필 제거 및 표시 이름 통합 완료. 화면 패치는 해시 검증된 관리자 설치 스크립트로 준비했습니다.");
console.log(installerPath);
