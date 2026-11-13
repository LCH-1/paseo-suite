import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isHndGroup,
  mergeHndHooks,
  mergeProfileSettings,
  syncProfileSettings,
} from "./profile-hooks";

const hnd = (args: string) => ({
  hooks: [
    {
      type: "command",
      command: `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@lch-1\\hnd\\bin\\hnd.mjs" "--state-home" "C:\\Users\\u\\.hnd" "hook" "claude"${args}`,
      timeout: 5,
    },
  ],
});
const other = { hooks: [{ type: "command", command: "node notify.mjs" }] };
const user = {
  statusLine: { type: "command", command: "x" },
  hooks: {
    SessionStart: [{ matcher: "startup|resume", ...hnd("") }, other],
    UserPromptSubmit: [hnd(' "prompt"')],
    PreToolUse: [other],
  },
};

test("only HND hook groups are recognized", () => {
  assert.equal(isHndGroup(hnd("")), true);
  assert.equal(
    isHndGroup({ hooks: [{ command: "hnd hook claude stop" }] }),
    true,
  );
  assert.equal(isHndGroup(other), false);
  assert.equal(
    isHndGroup({ hooks: [hnd("").hooks[0], other.hooks[0]] }),
    false,
  );
  assert.equal(isHndGroup({ hooks: [] }), false);
});

test("a profile gets the user's HND hooks and keeps its own settings and hooks", () => {
  const profile = { model: "opus", hooks: { Stop: [other] } };
  const next = mergeHndHooks(profile, user);
  assert.deepEqual(next, {
    model: "opus",
    hooks: {
      Stop: [other],
      SessionStart: [{ matcher: "startup|resume", ...hnd("") }],
      UserPromptSubmit: [hnd(' "prompt"')],
    },
  });
  assert.equal("statusLine" in next, false);
});

test("stale HND hooks in a profile are replaced and removed when the user has none", () => {
  const profile = {
    hooks: { SessionStart: [hnd(' "old"')], SessionEnd: [hnd(' "end"')] },
  };
  assert.deepEqual(mergeHndHooks(profile, user).hooks, {
    SessionStart: [{ matcher: "startup|resume", ...hnd("") }],
    UserPromptSubmit: [hnd(' "prompt"')],
  });
  assert.deepEqual(
    mergeHndHooks(profile, { hooks: { PreToolUse: [other] } }),
    {},
  );
});

test("sync writes missing profiles, skips the user directory and unreadable files, and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-hooks-"));
  try {
    const userHome = join(root, "user");
    await mkdir(join(userHome, ".claude"), { recursive: true });
    await writeFile(
      join(userHome, ".claude", "settings.json"),
      JSON.stringify(user),
    );
    const fresh = join(root, "a"),
      kept = join(root, "b"),
      broken = join(root, "c");
    for (const dir of [fresh, kept, broken]) await mkdir(dir);
    await writeFile(
      join(kept, "settings.json"),
      JSON.stringify({ model: "sonnet" }),
    );
    await writeFile(join(broken, "settings.json"), "{ not json");
    const homes = [
      fresh,
      kept,
      broken,
      join(root, "missing"),
      join(userHome, ".claude"),
    ];
    assert.deepEqual(await syncProfileSettings(userHome, homes), [fresh, kept]);
    const written = JSON.parse(
      await readFile(join(kept, "settings.json"), "utf8"),
    );
    assert.equal(written.model, "sonnet");
    assert.equal(written.hooks.SessionStart.length, 1);
    assert.equal(
      await readFile(join(broken, "settings.json"), "utf8"),
      "{ not json",
    );
    assert.deepEqual(await syncProfileSettings(userHome, homes), []);
    await writeFile(join(userHome, ".claude", "settings.json"), "{ editing");
    await writeFile(
      join(kept, "settings.json"),
      JSON.stringify({ model: "sonnet" }),
    );
    assert.deepEqual(await syncProfileSettings(userHome, homes), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("사용자 설정의 대화 기록 보존 기간을 프로필에 맞추고 사용자 값이 없으면 프로필 값을 그대로 둔다", () => {
  assert.deepEqual(
    mergeProfileSettings(
      { model: "opus", cleanupPeriodDays: 30 },
      { cleanupPeriodDays: 90 },
    ),
    { model: "opus", cleanupPeriodDays: 90 },
  );
  assert.deepEqual(
    mergeProfileSettings({ cleanupPeriodDays: 365 }, { model: "sonnet" }),
    { cleanupPeriodDays: 365 },
  );
  assert.deepEqual(
    mergeProfileSettings({}, { cleanupPeriodDays: "90" as unknown as number }),
    {},
  );
  // Values the CLI rejects (whole days from 1) are not copied into every profile.
  for (const days of [0, -1, 1.5])
    for (const profile of [{}, { cleanupPeriodDays: 30 }])
      assert.deepEqual(
        mergeProfileSettings(profile, { cleanupPeriodDays: days }),
        profile,
      );
  assert.deepEqual(mergeProfileSettings({}, { cleanupPeriodDays: 1 }), {
    cleanupPeriodDays: 1,
  });
});

test("동기화는 보존 기간만 있는 사용자 설정도 settings.json 이 없는 프로필에 쓰고 다시 쓰지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-retention-"));
  try {
    const userHome = join(root, "user");
    await mkdir(join(userHome, ".claude"), { recursive: true });
    await writeFile(
      join(userHome, ".claude", "settings.json"),
      JSON.stringify({ cleanupPeriodDays: 90, statusLine: { type: "x" } }),
    );
    const fresh = join(root, "fresh"),
      hooked = join(root, "hooked");
    await mkdir(fresh);
    await mkdir(hooked);
    await writeFile(
      join(hooked, "settings.json"),
      JSON.stringify({ hooks: { Stop: [other] } }),
    );
    assert.deepEqual(await syncProfileSettings(userHome, [fresh, hooked]), [
      fresh,
      hooked,
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(fresh, "settings.json"), "utf8")),
      { cleanupPeriodDays: 90 },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(hooked, "settings.json"), "utf8")),
      { hooks: { Stop: [other] }, cleanupPeriodDays: 90 },
    );
    assert.deepEqual(await syncProfileSettings(userHome, [fresh, hooked]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
