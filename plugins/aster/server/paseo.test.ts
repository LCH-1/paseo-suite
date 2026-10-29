import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCommand, portableCommand, runPaseo } from "./paseo.ts";
import { readSettings } from "./accounts.ts";

test("설정 파일 없이 설치된 Paseo 명령을 사용하고 개발 프로젝트 경로를 요구하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-default-"));
  assert.deepEqual(await readSettings(join(root, "missing.json")), { command: defaultCommand(), capacities: {} });
  const file = join(root, "settings.json");
  await writeFile(file, JSON.stringify({ capacities: { example: 5 } }));
  assert.deepEqual(await readSettings(file), { command: defaultCommand(), capacities: { example: 5 } });
});

test("기존 개발용 CLI 경로는 대상 PC의 Paseo로 바꾸고 사용자 지정 명령은 유지한다", () => {
  for (const argument of ["C:\\old\\node_modules\\@getpaseo\\cli\\dist\\index.js", "/old/node_modules/@getpaseo/cli/dist/index.js"]) {
    assert.deepEqual(portableCommand({ file: "/old/node", args: [argument] }), defaultCommand());
  }
  const custom = { file: "/custom/paseo", args: ["--custom"] };
  assert.deepEqual(portableCommand(custom), custom);
});

test("손상된 설정 파일은 기본값으로 숨기지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-invalid-"));
  const file = join(root, "settings.json");
  await writeFile(file, "{");
  await assert.rejects(readSettings(file), SyntaxError);
});

test("외부 Node CLI 없이 명령 실행과 공백·한글 인수를 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-command-"));
  const file = join(root, "command.cjs");
  await writeFile(file, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const args = ["usage", "공백 포함 인수", "--home", join(root, "테스트 홈")];
  assert.deepEqual(JSON.parse(await runPaseo({ file: process.execPath, args: [file] }, args, AbortSignal.timeout(5_000))), args);
});
