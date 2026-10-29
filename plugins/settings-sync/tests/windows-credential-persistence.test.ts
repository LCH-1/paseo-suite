import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runProviderSecret, WindowsProviderSecureStore } from "../server/provider-credentials";

test("Windows writes use the same Enterprise persistence as the official Claude Bun runtime", { skip: process.platform !== "win32" }, async () => {
  const store = new WindowsProviderSecureStore();
  const service = "Paseo-synthetic-persistence-" + randomUUID();
  try {
    await store.write(service, "claude-code-user", "synthetic-value");
    const readback = await store.read(service, "claude-code-user");
    assert.equal(readback?.value, "synthetic-value");
    assert.equal(readback?.persistence, 3);
  } finally { await store.remove(service, "claude-code-user"); }
});

test("normalizing a legacy LocalMachine credential removes its stale physical twin without changing the value", { skip: process.platform !== "win32" }, async () => {
  const store = new WindowsProviderSecureStore();
  const legacy = new WindowsProviderSecureStore(async (exe, args, input) => {
    const adjusted = [...args];
    const offset = adjusted.indexOf("-EncodedCommand") + 1;
    const source = Buffer.from(adjusted[offset], "base64").toString("utf16le");
    assert.ok(source.includes("WriteWithPersistence(target,encoded,3);"));
    adjusted[offset] = Buffer.from(source.replace("public static void Write(string target,string encoded) { WriteWithPersistence(target,encoded,3); }", "public static void Write(string target,string encoded) { WriteWithPersistence(target,encoded,2); }"), "utf16le").toString("base64");
    return runProviderSecret(exe, adjusted, input);
  });
  const service = "Paseo-synthetic-persistence-" + randomUUID();
  const local = path.join(process.env.LOCALAPPDATA!, "Microsoft/Credentials");
  const roaming = path.join(process.env.APPDATA!, "Microsoft/Credentials");
  const before = new Set(await readdir(local));
  try {
    await legacy.write(service, "claude-code-user", "synthetic-old-generation");
    assert.equal((await store.read(service, "claude-code-user"))?.persistence, 2);
    const created = (await readdir(local)).filter(name => !before.has(name));
    await store.write(service, "claude-code-user", "synthetic-current-generation");
    const roamingNames = new Set(await readdir(roaming));
    const twins = created.filter(name => roamingNames.has(name));
    assert.equal(twins.length, 1, "Changing persistence alone leaves both storage variants on this Windows system");
    await store.normalizePersistence(service, "claude-code-user", "synthetic-current-generation");
    const after = new Set(await readdir(local));
    assert.equal(twins.some(name => after.has(name)), false, "The obsolete LocalMachine copy must be removed");
    const readback = await store.read(service, "claude-code-user");
    assert.equal(readback?.persistence, 3);
    assert.equal(readback?.value, "synthetic-current-generation");
  } finally { await store.remove(service, "claude-code-user"); }
});
