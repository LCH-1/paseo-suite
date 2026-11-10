import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rmdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { credentialStore } from "./credential-store";
import type { CredentialProviders } from "./credential-types";
import { ProviderCredentialSync } from "./credential-runtime.js";
import { CredentialSharing } from "./credential-sharing";
import { relayCredentials } from "../../client/credential-relay";
import { WindowsCredentialReader } from "../windows-credential-reader";
import { syntheticCredentialHost } from "../../tests/fixtures/credential-helper";
async function fixture(managed = true) {
  const root = await mkdtemp(path.join(tmpdir(), "aster-share-test-")),
    home = path.join(root, "paseo"),
    userHome = path.join(root, "user"),
    profile = managed
      ? path.join(home, "settings-sync", "provider-profiles", "claude-" + "1".repeat(24))
      : path.join(home, "legacy-claude");
  await mkdir(profile, { recursive: true });
  await mkdir(path.join(home, "paseo-accounts"));
  await mkdir(path.join(userHome, ".claude", "projects"), { recursive: true });
  await symlink(
    path.join(userHome, ".claude", "projects"),
    path.join(profile, "projects"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(
    path.join(profile, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "account-1", organizationUuid: "org-1" } }),
  );
  await writeFile(
    path.join(profile, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 1000000,
      },
    }),
  );
  const registry = path.join(home, "paseo-accounts", "accounts.json");
  await writeFile(
    registry,
    JSON.stringify({
      accounts: [
        {
          id: "claude",
          base: "claude",
          home: profile,
          email: null,
          identity: "account-1",
          signedIn: true,
        },
      ],
    }),
  );
  const providers: CredentialProviders = {
    claude: {
      enabled: true,
      env: { CLAUDE_CONFIG_DIR: profile, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile },
    },
  };
  return {
    root,
    home,
    userHome,
    profile,
    registry,
    providers,
    store: credentialStore(home, { userHome, platform: "linux" }),
  };
}
test("same-account newer tokens recover a cleared managed profile without moving it", async () => {
  const f = await fixture(),
    before = await f.store.read(f.providers),
    incoming = structuredClone(before.accounts[0].record!);
  incoming.expiresAt! += 500000;
  incoming.updatedAt += 500000;
  (incoming.credential.claudeAiOauth as Record<string, unknown>).expiresAt = incoming.expiresAt;
  await writeFile(path.join(f.profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
  assert.equal((await f.store.read(f.providers)).accounts[0].record, null);
  let configured = f.providers;
  const changed = await f.store.write(f.providers, [incoming], async (next) => {
    configured = next;
  });
  assert.equal(changed.length, 1);
  assert.equal(configured.claude.env?.CLAUDE_CONFIG_DIR, f.profile);
  assert.equal((await f.store.read(configured)).accounts[0].record?.expiresAt, incoming.expiresAt);
});
test("older tokens are preserved and explicit account logout is not undone", async () => {
  const f = await fixture(),
    before = await f.store.read(f.providers),
    incoming = structuredClone(before.accounts[0].record!);
  incoming.expiresAt!--;
  assert.deepEqual(
    await f.store.write(f.providers, [incoming], async () => {
      throw Error("No configuration changes expected");
    }),
    [],
  );
  const raw = JSON.parse(await readFile(f.registry, "utf8"));
  raw.accounts[0].signedIn = false;
  await writeFile(f.registry, JSON.stringify(raw));
  assert.equal((await f.store.read(f.providers)).accounts.length, 0);
  await assert.rejects(() => f.store.write(f.providers, [incoming], async () => {}));
});
test("manual authentication overrides are excluded", async () => {
  const f = await fixture();
  f.providers.claude.env!.ANTHROPIC_API_KEY = "synthetic-manual-key";
  assert.equal((await f.store.read(f.providers)).accounts.length, 0);
});

async function alias(f: Awaited<ReturnType<typeof fixture>>, sameIdentity = true) {
  const directory = path.join(
    f.home,
    "settings-sync",
    "provider-profiles",
    "claude-" + "2".repeat(24),
  );
  await mkdir(directory, { recursive: true });
  await symlink(
    path.join(f.userHome, ".claude", "projects"),
    path.join(directory, "projects"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const config = JSON.parse(await readFile(path.join(f.profile, ".claude.json"), "utf8"));
  if (!sameIdentity) config.oauthAccount.accountUuid = "account-2";
  await writeFile(path.join(directory, ".claude.json"), JSON.stringify(config));
  await writeFile(
    path.join(directory, ".credentials.json"),
    await readFile(path.join(f.profile, ".credentials.json")),
  );
  f.providers["claude-alias"] = {
    extends: "claude",
    enabled: true,
    env: { CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory },
  };
  const registry = JSON.parse(await readFile(f.registry, "utf8"));
  registry.accounts.push({ ...registry.accounts[0], id: "claude-alias", home: directory });
  await writeFile(f.registry, JSON.stringify(registry));
  return directory;
}

test("all physical aliases of the same account receive the newer credential without moving", async () => {
  const f = await fixture(),
    directory = await alias(f);
  const incoming = structuredClone((await f.store.read(f.providers)).accounts[0].record!);
  incoming.expiresAt! += 500000;
  incoming.updatedAt = incoming.expiresAt!;
  (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
  let configured = f.providers;
  await f.store.write(f.providers, [incoming], async (next) => {
    configured = next;
  });
  const after = await f.store.read(configured);
  assert.equal(after.accounts.length, 2);
  assert.ok(after.accounts.every((a) => a.record?.expiresAt === incoming.expiresAt));
  assert.equal(configured["claude-alias"].env?.CLAUDE_CONFIG_DIR, directory);
});

test("one busy CLI profile does not hide the other account", async () => {
  const f = await fixture();
  await alias(f, false);
  await mkdir(path.join(f.profile, ".oauth_refresh.lock"));
  const result = await f.store.read(f.providers);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts.find((a) => a.providerIds.includes("claude"))?.record, null);
  assert.ok(result.accounts.find((a) => a.providerIds.includes("claude-alias"))?.record);
});

test("logout between ownership capture and restoration cannot be overwritten", async () => {
  const f = await fixture(),
    incoming = structuredClone((await f.store.read(f.providers)).accounts[0].record!);
  incoming.expiresAt! += 500000;
  incoming.updatedAt = incoming.expiresAt!;
  (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
  const original = ProviderCredentialSync.prototype.record;
  let calls = 0;
  const interception = mock.method(
    ProviderCredentialSync.prototype,
    "record",
    async function (this: ProviderCredentialSync, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      if (++calls === 2) {
        const registry = JSON.parse(await readFile(f.registry, "utf8"));
        registry.accounts[0].signedIn = false;
        await writeFile(f.registry, JSON.stringify(registry));
      }
      return result;
    },
  );
  try {
    await assert.rejects(() => f.store.write(f.providers, [incoming], async () => {}));
    assert.equal(JSON.parse(await readFile(f.registry, "utf8")).accounts[0].signedIn, false);
    assert.equal(
      JSON.parse(await readFile(path.join(f.profile, ".credentials.json"), "utf8")).claudeAiOauth
        .expiresAt,
      incoming.expiresAt! - 500000,
    );
  } finally {
    interception.mock.restore();
  }
});

test("a later alias failure rolls back the whole update and releases CLI locks", async () => {
  const f = await fixture();
  await alias(f);
  const before = await f.store.read(f.providers),
    incoming = structuredClone(before.accounts[0].record!);
  incoming.expiresAt! += 500000;
  incoming.updatedAt = incoming.expiresAt!;
  (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
  let checks = 0;
  await assert.rejects(() =>
    f.store.write(
      f.providers,
      [incoming],
      async () => {},
      async () => {
        if (++checks === 2) throw Error("changed account settings");
      },
    ),
  );
  const after = await f.store.read(f.providers);
  assert.equal(after.accounts.length, 2);
  assert.ok(
    after.accounts.every((a) => a.record?.expiresAt === before.accounts[0].record?.expiresAt),
  );
});

test("a cleared legacy profile is isolated while registry identity and shared history survive", async () => {
  const f = await fixture(false),
    incoming = structuredClone((await f.store.read(f.providers)).accounts[0].record!);
  incoming.expiresAt! += 500000;
  incoming.updatedAt = incoming.expiresAt!;
  (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
  await writeFile(path.join(f.profile, ".credentials.json"), "{}");
  let configured = f.providers;
  // Linux credentials are simulated on Windows; precreate the shared junction
  // because unprivileged Windows cannot create a Linux-style directory symlink.
  const original = ProviderCredentialSync.prototype.restore;
  const prepare = mock.method(
    ProviderCredentialSync.prototype,
    "restore",
    async function (this: ProviderCredentialSync, ...args: Parameters<typeof original>) {
      const directory = path.join(
        f.home,
        "settings-sync",
        "provider-profiles",
        args[1].records[0].id,
      );
      await mkdir(directory, { recursive: true });
      await symlink(
        path.join(f.userHome, ".claude", "projects"),
        path.join(directory, "projects"),
        process.platform === "win32" ? "junction" : "dir",
      );
      return original.apply(this, args);
    },
  );
  try {
    await f.store.write(f.providers, [incoming], async (next) => {
      configured = next;
    });
  } finally {
    prepare.mock.restore();
  }
  const after = await f.store.read(configured);
  assert.equal(after.accounts.length, 1);
  assert.equal(after.accounts[0].record?.expiresAt, incoming.expiresAt);
  assert.ok(
    after.accounts[0].directory.startsWith(path.join(f.home, "settings-sync", "provider-profiles")),
  );
  const registry = JSON.parse(await readFile(f.registry, "utf8"));
  assert.equal(registry.accounts[0].identity, "account-1");
  assert.equal(registry.accounts[0].home, after.accounts[0].directory);
});

test("logout racing the registry CAS write is preserved with credential rollback", async () => {
  const f = await fixture(false),
    incoming = structuredClone((await f.store.read(f.providers)).accounts[0].record!);
  incoming.expiresAt! += 500000;
  incoming.updatedAt = incoming.expiresAt!;
  (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
  await writeFile(path.join(f.profile, ".credentials.json"), "{}");
  const original = ProviderCredentialSync.prototype.restore;
  const intercepted = mock.method(
    ProviderCredentialSync.prototype,
    "restore",
    async function (this: ProviderCredentialSync, ...args: Parameters<typeof original>) {
      const options = args[3]!,
        guard = options.beforeClaudeRegistryWrite;
      options.beforeClaudeRegistryWrite = async (record, raw) => {
        const registry = JSON.parse(await readFile(f.registry, "utf8"));
        registry.accounts[0].signedIn = false;
        await writeFile(f.registry, JSON.stringify(registry));
        await guard?.(record, raw);
      };
      return original.apply(this, args);
    },
  );
  try {
    await assert.rejects(() => f.store.write(f.providers, [incoming], async () => {}));
    assert.equal(JSON.parse(await readFile(f.registry, "utf8")).accounts[0].signedIn, false);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.profile, ".credentials.json"), "utf8")),
      {},
    );
  } finally {
    intercepted.mock.restore();
  }
});

for (const fail of [false, true])
  test(`Windows split credentials ${fail ? "roll back a partial write" : "round-trip without losing token chunks"}`, async () => {
    const f = await fixture(),
      values = new Map<string, string>();
    let failed = false;
    const secure = {
      async read(service: string, name: string) {
        const value = values.get(service + ":" + name);
        return value === undefined ? null : { value, updatedAt: Date.now() };
      },
      async write(service: string, name: string, value: string) {
        if (fail && !failed && name.endsWith("#1")) {
          failed = true;
          throw Error("synthetic interrupted chunk write");
        }
        values.set(service + ":" + name, value);
      },
      async remove(service: string, name: string) {
        values.delete(service + ":" + name);
      },
    };
    f.providers.claude.env!.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
    const storage = new ProviderCredentialSync({
      home: f.home,
      userHome: f.userHome,
      platform: "win32",
      env: {},
      secure,
    });
    const store = credentialStore(f.home, { userHome: f.userHome, storage });
    const before = await store.read(f.providers),
      incoming = structuredClone(before.accounts[0].record!);
    incoming.expiresAt! += 500000;
    incoming.updatedAt = incoming.expiresAt!;
    (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
    (incoming.credential.claudeAiOauth as any).accessToken =
      "synthetic-long-access-" + "x".repeat(8000);
    let configured = f.providers;
    const write = () =>
      store.write(f.providers, [incoming], async (next) => {
        configured = next;
      });
    if (fail) await assert.rejects(write);
    else await write();
    const after = await store.read(configured);
    assert.equal(
      after.accounts[0].record?.expiresAt,
      fail ? before.accounts[0].record?.expiresAt : incoming.expiresAt,
    );
    assert.equal(
      (after.accounts[0].record!.credential.claudeAiOauth as any).accessToken,
      fail ? "synthetic-access" : (incoming.credential.claudeAiOauth as any).accessToken,
    );
    assert.ok(![...values.keys()].some((key) => key.endsWith("#p")));
  });

test("status checks of a Windows login share one resident helper and still see a login renewed in between", async () => {
  const f = await fixture(),
    host = syntheticCredentialHost(),
    reader = new WindowsCredentialReader({ spawn: host.spawn });
  f.providers.claude.env!.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
  const storage = (resident: boolean) =>
    credentialStore(f.home, {
      userHome: f.userHome,
      storage: new ProviderCredentialSync({
        home: f.home,
        userHome: f.userHome,
        platform: "win32",
        env: {},
        run: host.run,
        ...(resident ? { reader } : {}),
      }),
    });
  const login = (token: string, expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "synthetic-refresh", expiresAt } });
  // The entry name is derived from the profile path; whatever the store asks for first is it.
  await storage(false).read(f.providers);
  const target = host.oneShots[0].target.replace(/#m$/, "");
  host.entries.set(target, login("synthetic-windows-access", 2_000_000_000_000));
  host.oneShots.length = 0;
  try {
    // Before: every window and host asking for the status costs a process per stored entry.
    for (let check = 0; check < 5; check++) await storage(false).read(f.providers);
    assert.equal(host.oneShots.length, 10);
    assert.equal(host.helpers.length, 0);
    host.oneShots.length = 0;
    const store = storage(true);
    for (let check = 0; check < 5; check++)
      assert.equal((await store.read(f.providers)).accounts[0].record?.expiresAt, 2_000_000_000_000);
    assert.equal(host.oneShots.length, 0);
    assert.equal(host.helpers.length, 1);
    // The CLI renews on its own; the old access token is dead from that moment.
    host.entries.set(target, login("synthetic-renewed-by-cli", 2_100_000_000_000));
    const renewed = (await store.read(f.providers)).accounts[0].record!;
    assert.equal(renewed.expiresAt, 2_100_000_000_000);
    assert.equal((renewed.credential.claudeAiOauth as any).accessToken, "synthetic-renewed-by-cli");
    assert.equal(host.helpers.length, 1);
    assert.equal(host.oneShots.length, 0);
  } finally {
    reader.dispose();
  }
});

test("encrypted relay survives expiry, a busy alias, cleared credentials and a later logout across isolated stores", async () => {
  const source = await fixture(),
    target = await fixture(),
    cleared = await fixture(),
    aliasDirectory = await alias(target);
  let now = Date.now();
  const wire: unknown[] = [];
  const credential = (token: string, expiry: number) => ({
    claudeAiOauth: { accessToken: token, refreshToken: "synthetic-refresh", expiresAt: expiry },
  });
  for (const f of [source, target, cleared])
    await writeFile(
      path.join(f.profile, ".credentials.json"),
      JSON.stringify(credential("synthetic-old", now - 1000)),
    );
  await writeFile(
    path.join(aliasDirectory, ".credentials.json"),
    JSON.stringify(credential("synthetic-old", now - 1000)),
  );
  await writeFile(path.join(cleared.profile, ".credentials.json"), "{}");
  const lock = path.join(aliasDirectory, ".oauth_refresh.lock");
  await mkdir(lock);
  await writeFile(
    path.join(source.profile, ".credentials.json"),
    JSON.stringify(credential("synthetic-next-1", now + 3600000)),
  );
  const peers = [source, target, cleared].map((f, index) => {
    const crypto = new CredentialSharing(() => now);
    let configured = f.providers;
    return {
      serverId: String(index),
      client: {
        async invokePluginRpc(_: string, method: string, input: any) {
          wire.push({ method, input });
          const state = await f.store.read(configured);
          if (method.endsWith("status")) return crypto.status(state);
          if (method.endsWith("export"))
            return crypto.export(state, input.publicKey, input.identities);
          const records = crypto.open(input, state),
            changed = await f.store.write(configured, records, async (next) => {
              configured = next;
            });
          return { changed: changed.length };
        },
      },
    };
  });
  await relayCredentials(peers, now);
  assert.ok(
    (await target.store.read(target.providers)).accounts.every(
      (a) => a.record === null || a.record.expiresAt! < now,
    ),
  );
  assert.equal(
    (await cleared.store.read(cleared.providers)).accounts[0].record?.expiresAt,
    now + 3600000,
  );
  // Release only the empty lock created by this isolated fixture.
  await rmdir(lock);
  await relayCredentials(peers, now);
  assert.ok(
    (await target.store.read(target.providers)).accounts.every(
      (a) => a.record?.expiresAt === now + 3600000,
    ),
  );
  now += 3600001;
  const registry = JSON.parse(await readFile(cleared.registry, "utf8"));
  registry.accounts[0].signedIn = false;
  await writeFile(cleared.registry, JSON.stringify(registry));
  await writeFile(path.join(cleared.profile, ".credentials.json"), "{}");
  await writeFile(
    path.join(source.profile, ".credentials.json"),
    JSON.stringify(credential("synthetic-next-2", now + 3600000)),
  );
  await relayCredentials(peers, now);
  assert.ok(
    (await target.store.read(target.providers)).accounts.every(
      (a) => a.record?.expiresAt === now + 3600000,
    ),
  );
  assert.equal((await cleared.store.read(cleared.providers)).accounts.length, 0);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(cleared.profile, ".credentials.json"), "utf8")),
    {},
  );
  assert.ok(!JSON.stringify(wire).includes("synthetic-next-"));
  assert.equal(target.providers["claude-alias"].env?.CLAUDE_CONFIG_DIR, aliasDirectory);
});

test("a usable local login is kept while an expiring alias of the same account is repaired", async () => {
  const f = await fixture(),
    directory = await alias(f);
  const before = await f.store.read(f.providers);
  const incoming = structuredClone(before.accounts[0].record!);
  const now = Date.now();
  incoming.expiresAt = now + 8 * 3600000;
  incoming.updatedAt = incoming.expiresAt;
  (incoming.credential.claudeAiOauth as any).expiresAt = incoming.expiresAt;
  await writeFile(
    path.join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "old", expiresAt: now + 60000 } }),
  );
  await f.store.write(f.providers, [incoming], async () => {}, async () => {}, now + 600000);
  const after = await f.store.read(f.providers);
  const local = after.accounts.find((a) => a.directory === f.profile)!;
  const repaired = after.accounts.find((a) => a.directory === directory)!;
  assert.equal(local.record?.expiresAt, before.accounts[0].record?.expiresAt);
  assert.equal(repaired.record?.expiresAt, incoming.expiresAt);
});

test("accounts with a provider name outside claude-* are shared too", async () => {
  const f = await fixture();
  const directory = await alias(f);
  f.providers["mengsk-claude"] = f.providers["claude-alias"];
  delete f.providers["claude-alias"];
  const registry = JSON.parse(await readFile(f.registry, "utf8"));
  registry.accounts[1].id = "mengsk-claude";
  await writeFile(f.registry, JSON.stringify(registry));
  const state = await f.store.read(f.providers);
  assert.ok(state.accounts.some((a) => a.directory === directory && a.providerIds.includes("mengsk-claude")));
});

async function foreignRecord(email = "second@example.test") {
  const source = await fixture();
  const oauth = { accountUuid: "account-9", organizationUuid: "org-9", emailAddress: email };
  await writeFile(path.join(source.profile, ".claude.json"), JSON.stringify({ oauthAccount: oauth }));
  return structuredClone((await source.store.read(source.providers)).accounts[0].record!);
}

test("a new account is registered like a local login: hidden provider, registry, shared history", async () => {
  const f = await fixture();
  const record = await foreignRecord();
  let configured = f.providers;
  // Linux credentials are simulated on Windows; precreate the shared junction as above.
  const directory = path.join(f.home, "settings-sync", "provider-profiles");
  const original = ProviderCredentialSync.prototype.restore;
  const prepare = mock.method(ProviderCredentialSync.prototype, "restore", async function (this: ProviderCredentialSync, ...args: Parameters<typeof original>) {
    const leaf = path.join(directory, args[1].records[0].id);
    await mkdir(leaf, { recursive: true });
    await symlink(path.join(f.userHome, ".claude", "projects"), path.join(leaf, "projects"), process.platform === "win32" ? "junction" : "dir");
    return original.apply(this, args);
  });
  try {
    assert.equal(await f.store.provision(f.providers, record, async (next) => { configured = next; }), true);
  } finally {
    prepare.mock.restore();
  }
  const providerId = "claude-" + record.identity.slice(0, 12);
  assert.equal(configured[providerId].selectable, false);
  assert.equal(configured[providerId].extends, "claude");
  assert.equal(configured.claude.env?.CLAUDE_CONFIG_DIR, f.profile);
  const after = await f.store.read(configured);
  assert.equal(after.accounts.length, 2);
  const added = after.accounts.find((a) => a.identity === record.identity)!;
  assert.equal(added.record?.expiresAt, record.expiresAt);
  const entry = JSON.parse(await readFile(f.registry, "utf8")).accounts.find((a: any) => a.id === providerId);
  assert.equal(entry.identity, "org-9|account-9");
  assert.equal(entry.signedIn, true);
  assert.equal(await f.store.provision(configured, record, async () => { throw Error("no change expected"); }), false);
});

test("a signed-out account, a same-address entry and a forged identity are not provisioned", async () => {
  const f = await fixture();
  const record = await foreignRecord();
  const registry = JSON.parse(await readFile(f.registry, "utf8"));
  registry.accounts.push({ id: "claude-out", base: "claude", home: null, email: "second@example.test", identity: "org-9|account-9", signedIn: false });
  await writeFile(f.registry, JSON.stringify(registry));
  assert.ok((await f.store.read(f.providers)).declined?.includes(record.identity));
  const reject = () => async () => { throw Error("must not patch"); };
  await assert.rejects(() => f.store.provision(f.providers, record, reject()), /로그아웃/);
  const clean = await fixture();
  await assert.rejects(() => clean.store.provision(clean.providers, { ...record, identity: "c".repeat(64) }, reject()), /확인할 수 없습니다/);
  const raw = JSON.parse(await readFile(clean.registry, "utf8"));
  raw.accounts.push({ id: "other", base: "claude", home: null, email: "second@example.test", identity: "org-1|someone", signedIn: true });
  await writeFile(clean.registry, JSON.stringify(raw));
  await assert.rejects(() => clean.store.provision(clean.providers, record, reject()), /이미 있어/);
});

test("a dead CLI's refresh lock is reclaimed but a live or ownerless one stays busy", async () => {
  const f = await fixture();
  const lock = path.join(f.profile, ".oauth_refresh.lock");
  const old = new Date(Date.now() - 120000);
  const blocked = async () => (await f.store.read(f.providers)).accounts[0].record === null;
  await mkdir(lock);
  await utimes(lock, old, old);
  assert.equal(await blocked(), true, "no owner: stays busy");
  await writeFile(lock + ".owner", JSON.stringify({ pid: process.pid }));
  assert.equal(await blocked(), true, "live owner: stays busy");
  await writeFile(lock + ".owner", JSON.stringify({ pid: 2147483000 }));
  await utimes(lock, new Date(), new Date());
  assert.equal(await blocked(), true, "recently touched: stays busy");
  await utimes(lock, old, old);
  assert.equal(await blocked(), false, "dead owner: reclaimed");
  await assert.rejects(() => readFile(lock + ".owner"));
});

test("a delivered login never carries a refresh token and never costs the receiver its own", async () => {
  const sender = new CredentialSharing(() => Date.now()), receiver = new CredentialSharing(() => Date.now());
  const source = await fixture();
  const fresh = Date.now() + 8 * 3600000;
  await writeFile(path.join(source.profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "source-access", refreshToken: "source-refresh", expiresAt: fresh } }));
  const sourceState = await source.store.read(source.providers);
  assert.equal(new Set(sender.status(sourceState).accounts[0].chains).size, 1);
  const target = await fixture();
  await writeFile(path.join(target.profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: "target-own-refresh", expiresAt: Date.now() + 60000 } }));
  const envelope = sender.export(sourceState, receiver.publicKey, [sourceState.accounts[0].identity]);
  const records = receiver.open(envelope, await target.store.read(target.providers));
  assert.equal((records[0].credential.claudeAiOauth as any).refreshToken, undefined);
  await target.store.write(target.providers, records, async () => {}, async () => {}, Date.now() + 600000);
  const after = JSON.parse(await readFile(path.join(target.profile, ".credentials.json"), "utf8")).claudeAiOauth;
  assert.equal(after.accessToken, "source-access");
  assert.equal(after.refreshToken, "target-own-refresh");
  const cleared = await fixture();
  await writeFile(path.join(cleared.profile, ".credentials.json"), "{}");
  const opened = receiver.open(envelope, await cleared.store.read(cleared.providers));
  await cleared.store.write(cleared.providers, opened, async () => {}, async () => {}, Date.now() + 600000);
  const borrowed = JSON.parse(await readFile(path.join(cleared.profile, ".credentials.json"), "utf8")).claudeAiOauth;
  assert.equal(borrowed.accessToken, "source-access");
  assert.equal(borrowed.refreshToken, undefined);
  assert.equal((await cleared.store.read(cleared.providers)).accounts[0].record?.expiresAt, fresh);
});

test("releasing a duplicated login removes only that refresh token and keeps access working", async () => {
  const f = await fixture();
  await writeFile(path.join(f.profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access", refreshToken: "shared", expiresAt: Date.now() + 3600000 } }));
  const record = (await f.store.read(f.providers)).accounts[0].record!;
  const { refreshToken: _drop, ...oauth } = record.credential.claudeAiOauth as Record<string, unknown>;
  const changed = await f.store.write(f.providers, [{ ...record, updatedAt: record.updatedAt + 1, credential: { claudeAiOauth: oauth } }], async () => {}, async () => {}, 0, () => true);
  assert.equal(changed.length, 1);
  const after = JSON.parse(await readFile(path.join(f.profile, ".credentials.json"), "utf8")).claudeAiOauth;
  assert.equal(after.accessToken, "access");
  assert.equal(after.refreshToken, undefined);
});
