import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isHndGroup, mergeHndHooks, syncHndHooks } from "./profile-hooks";

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
    assert.deepEqual(await syncHndHooks(userHome, homes), [fresh, kept]);
    const written = JSON.parse(
      await readFile(join(kept, "settings.json"), "utf8"),
    );
    assert.equal(written.model, "sonnet");
    assert.equal(written.hooks.SessionStart.length, 1);
    assert.equal(
      await readFile(join(broken, "settings.json"), "utf8"),
      "{ not json",
    );
    assert.deepEqual(await syncHndHooks(userHome, homes), []);
    await writeFile(join(userHome, ".claude", "settings.json"), "{ editing");
    await writeFile(
      join(kept, "settings.json"),
      JSON.stringify({ model: "sonnet" }),
    );
    assert.deepEqual(await syncHndHooks(userHome, homes), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
