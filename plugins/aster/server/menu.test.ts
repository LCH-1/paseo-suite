import assert from "node:assert/strict";
import test from "node:test";
import { menuReplacements, patchClaudeMenu, singleClaudePresentation } from "./menu.ts";

const provider = (id: string) => ({ provider: id, id, enabled: true });
const selectableFilter = menuReplacements[1].after.split(".filter(")[1].split(").slice()")[0];
const filterRows = new Function("rows", `return rows.filter(${selectableFilter})`) as (rows: ReturnType<typeof provider>[]) => ReturnType<typeof provider>[];

test("새 대화에는 Claude 선택을 하나만 남긴다", () => {
  assert.deepEqual(filterRows([provider("claude"), provider("claude-second"), provider("codex")]).map((row) => row.provider), ["claude", "codex"]);
});

test("기존 계정별 대화의 모델 목록은 유지한다", () => {
  assert.deepEqual(filterRows([provider("claude-second")]).map((row) => row.provider), ["claude-second"]);
});

test("기본 Claude가 비활성화된 경우 사용 가능한 계정을 숨기지 않는다", () => {
  assert.deepEqual(filterRows([{ ...provider("claude"), enabled: false }, provider("claude-second")]).map((row) => row.provider), ["claude-second"]);
});

test("계정 프로필만 제거하고 내부 계정 연결은 유지한다", () => {
  const providers = { claude: { label: "Claude 1", enabled: true }, "claude-second": { extends: "claude", enabled: true }, codex: { enabled: true } };
  const profiles = [
    { id: "one", name: "One", provider: "claude" },
    { id: "two", name: "Two", provider: "claude-second" },
    { id: "codex", name: "Codex", provider: "codex" },
  ];
  const result = singleClaudePresentation(profiles, providers);
  assert.deepEqual(result.profiles.map((profile) => profile.id), ["codex"]);
  assert.deepEqual(result.labels, [{ id: "claude", label: "Claude" }, { id: "claude-second", label: "Claude" }]);
  assert.equal(providers["claude-second"].enabled, true);
});

test("버전이 다르면 중간 수정 없이 중단한다", () => {
  assert.throws(() => patchClaudeMenu(menuReplacements[0].before), /예상 버전/);
});

test("메뉴 변경을 반복 적용해도 결과가 같다", () => {
  const bundle = menuReplacements.map((replacement) => replacement.before).join("; ");
  const patched = patchClaudeMenu(bundle);
  assert.equal(patchClaudeMenu(patched), patched);
});
