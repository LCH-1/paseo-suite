import assert from "node:assert/strict";
import test from "node:test";
import { providerFamily, providerPolicy } from "./provider-policy";

test("선택기는 Claude·Codex 두 개만 노출하고 이름이 다른 계정 별칭도 실행 가능하게 유지", () => {
  const providers = {
    claude: { command: ["original"], env: { PRIVATE: "untouched" } },
    codex: {},
    "mengsk-claude": { extends: "claude", enabled: true },
    "codex-second": { extends: "codex", enabled: true },
    cursor: { extends: "acp" },
    pi: { enabled: true },
  };
  const patch = providerPolicy(providers);
  assert.deepEqual(
    Object.entries(patch)
      .filter(([, entry]) => entry.selectable)
      .map(([id]) => id)
      .sort(),
    ["claude", "codex"],
  );
  assert.deepEqual(patch["mengsk-claude"], {
    enabled: true,
    selectable: false,
  });
  assert.deepEqual(patch["codex-second"], { enabled: true, selectable: false });
  assert.equal(patch.pi.enabled, false);
  assert.equal(patch.cursor.enabled, false);
  assert.equal(providerFamily("mengsk-claude", providers), "claude");
  assert.deepEqual(providers.claude.env, { PRIVATE: "untouched" });
  assert.deepEqual(
    providerPolicy(
      Object.fromEntries(
        Object.entries({ ...providers, ...patch }).map(([id, entry]) => [
          id,
          { ...providers[id as keyof typeof providers], ...entry },
        ]),
      ),
    ),
    {},
  );
});

test("깨진 상속 설정은 계정 가족을 임의 추정하지 않는다", () => {
  assert.throws(
    () => providerFamily("a", { a: { extends: "b" }, b: { extends: "a" } }),
    /순환/,
  );
});
