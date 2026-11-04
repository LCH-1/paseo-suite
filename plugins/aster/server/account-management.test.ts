import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerAccountManagement } from "./account-management";
import { accountsRpc } from "../shared/accounts-rpc";

test("두 공식 로그인 흐름은 기존 계정·대화 폴더를 유지하며 내부 계정을 자동 등록", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-registration-"));
  const handlers = new Map<string, any>(),
    terminals: any[] = [];
  const config: any = {
    providers: {
      claude: { command: ["official-claude"] },
      codex: { command: ["official-codex"] },
    },
  };
  const paseo: any = {
    config: {
      get: async () => ({ config }),
      patch: async (patch: any) => {
        for (const [id, provider] of Object.entries(patch.providers ?? {}))
          config.providers[id] = {
            ...config.providers[id],
            ...(provider as any),
          };
      },
    },
    workspaces: {
      ref: () => ({
        refresh: async () => ({ id: "workspace", workspaceDirectory: root }),
      }),
      list: async () => ({
        entries: [
          { id: "workspace", name: "Fixture", workspaceDirectory: root },
        ],
      }),
    },
    terminals: {
      create: async (input: any) => {
        terminals.push(input);
        return { id: `terminal-${terminals.length}` };
      },
    },
  };
  await mkdir(join(root, "plugin", "server"), { recursive: true });
  await writeFile(
    join(root, "plugin", "server", "account-login.mjs"),
    "// fixture",
  );
  await mkdir(join(root, "paseo-accounts"));
  await writeFile(
    join(root, "paseo-accounts", "accounts.json"),
    JSON.stringify({
      version: 1,
      extra: "preserved",
      accounts: [
        { id: "old", base: "claude", identity: "other", signedIn: true },
      ],
    }),
  );
  const dispose = registerAccountManagement(
    {
      handle: (contract: any, handler: any) =>
        handlers.set(contract.name, handler),
    } as any,
    async () => [],
    {
      home: root,
      userHome: root,
      pluginPath: async () => join(root, "plugin"),
    },
  );
  const call = (contract: any, input = {}) =>
    handlers.get(contract.name)(input, { paseo });
  try {
    for (const base of ["claude", "codex"] as const) {
      const flow = await call(accountsRpc.add, {
        base,
        workspaceId: "workspace",
      });
      const launcher = JSON.parse(terminals.at(-1).args[1]);
      assert.equal(launcher.command[0], `official-${base}`);
      if (base === "claude") {
        await writeFile(
          join(launcher.home, ".claude.json"),
          JSON.stringify({
            oauthAccount: {
              emailAddress: "fixture@example.invalid",
              accountUuid: "account",
              organizationUuid: "organization",
            },
          }),
        );
        assert.equal(
          await realpath(join(launcher.home, "projects")),
          await realpath(join(root, ".claude", "projects")),
        );
      } else
        await writeFile(
          join(launcher.home, "auth.json"),
          JSON.stringify({
            tokens: {
              access_token: "synthetic-token",
              account_id: "account-id",
            },
          }),
        );
      await writeFile(launcher.done, '{"success":true}');
      const state = await call(accountsRpc.status);
      assert.match(
        state.flows.find((entry: any) => entry.id === flow.id).status,
        /등록 완료/,
      );
    }
    const registry = JSON.parse(
      await readFile(join(root, "paseo-accounts", "accounts.json"), "utf8"),
    );
    assert.equal(registry.extra, "preserved");
    assert.equal(registry.accounts.length, 3);
    assert.equal(
      registry.accounts.find((entry: any) => entry.id === "old").identity,
      "other",
    );
    const added = Object.entries(config.providers).filter(
      ([id]) => !["claude", "codex"].includes(id),
    );
    assert.equal(added.length, 2);
    assert.ok(
      added.every(
        ([, provider]: any) =>
          provider.enabled && provider.selectable === false && provider.label,
      ),
    );
    assert.deepEqual(config.providers.codex.command, ["official-codex"]);
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
});
