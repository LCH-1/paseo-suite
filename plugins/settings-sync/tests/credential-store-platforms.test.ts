import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStore } from "../server/credential-store";

function keychain() {
  const entries = new Map<string, string>();
  let writes = 0;
  const run = async (exe: string, args: string[], input = "") => {
    assert.equal(exe, "security");
    if (args[0] === "-i") {
      assert.deepEqual(args, ["-i"]);
      writes++;
      // Apple's readline drops an unterminated command at EOF.
      for (const line of input.split("\n").slice(0, -1)) {
        assert.ok(Buffer.byteLength(line) < 4096);
        const match = /^add-generic-password -a paseo-nest -s ([0-9a-f-]{36}) -w ([A-Za-z0-9+/=]+)$/.exec(line);
        assert.ok(match);
        entries.set(match[1], match[2]);
      }
      return "";
    }
    const id = args[args.indexOf("-s") + 1];
    if (args[0] === "find-generic-password") {
      if (!entries.has(id)) throw new Error("No keychain entry");
      return entries.get(id)!;
    }
    assert.equal(args[0], "delete-generic-password");
    entries.delete(id);
    return "";
  };
  return { run, entries, writes: () => writes };
}

for (const [label, password] of [["64 characters", "a".repeat(64)], ["Unicode and shell punctuation", "한글🔑 \"'\\\n".repeat(8)]]) {
  test(`macOS restores a complete ${label} key in another instance`, async () => {
    const os = keychain();
    const reference = await new CredentialStore("darwin", os.run).protect(password);
    const restarted = new CredentialStore("darwin", os.run);
    assert.equal(await restarted.reveal(reference), password);
    assert.equal(os.entries.size, 1);
    await restarted.remove(reference);
    assert.equal(os.entries.size, 0);
  });
}

test("an oversized macOS interactive command is rejected before a partial key is stored", async () => {
  const os = keychain();
  await assert.rejects(new CredentialStore("darwin", os.run).protect("가".repeat(1024)), /길이/);
  assert.equal(os.writes(), 0);
  assert.equal(os.entries.size, 0);
});
