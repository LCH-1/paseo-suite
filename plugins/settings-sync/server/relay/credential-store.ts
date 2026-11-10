import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ProviderCredentialSync,
  credentialRuntimeVersion,
  withCredentialLocks,
} from "./credential-runtime.js";
import { sharedWindowsCredentialReader } from "../windows-credential-reader";
import type {
  CredentialOwnership,
  CredentialProviders,
  CredentialState,
  SharedCredential,
} from "./credential-types";

const authKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL",
];
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const accountIdentity = (oauth: Record<string, unknown> | null) => {
  const stable = oauth?.accountUuid ?? oauth?.accountId ?? oauth?.emailAddress;
  return typeof stable === "string"
    ? hash(["claude", stable, oauth?.organizationUuid ?? oauth?.organizationId ?? null])
    : null;
};
async function json(file: string): Promise<Record<string, unknown>> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576)
    throw Error("Aster: 계정 메타데이터 경로를 확인하세요.");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!object(value)) throw Error("Aster: 계정 메타데이터 형식을 확인하세요.");
  return value;
}
const normalized = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

export function credentialStore(
  home: string,
  options: { userHome?: string; platform?: NodeJS.Platform; storage?: ProviderCredentialSync } = {},
) {
  if (credentialRuntimeVersion !== 3)
    throw Error("Aster: 인증 저장 런타임 버전이 일치하지 않습니다.");
  const userHome = options.userHome ?? homedir();
  // Each status call reads every login, and several windows and hosts ask about once a minute.
  const windows = (options.platform ?? process.platform) === "win32" && process.platform === "win32";
  const store =
    options.storage ??
    new ProviderCredentialSync({
      home,
      userHome: options.userHome,
      platform: options.platform,
      ...(windows ? { reader: sharedWindowsCredentialReader() } : {}),
    });
  async function read(providers: CredentialProviders): Promise<CredentialState> {
    const registry = await json(path.join(home, "paseo-accounts", "accounts.json"));
    const registered = Array.isArray(registry.accounts) ? registry.accounts.filter(object) : [];
    const accounts: CredentialOwnership[] = [];
    for (const profile of store
      .profiles(providers)
      .filter(
        (p) =>
          p.vendor === "claude" &&
          p.providerIds.some(
            (id) => providers[id] && providers[id].enabled !== false,
          ),
      )) {
      if (authKeys.some((k) => profile.env[k])) continue;
      const localAccounts = registered.filter(
        (a) =>
          a.base === "claude" &&
          a.signedIn === true &&
          typeof a.id === "string" &&
          profile.providerIds.includes(a.id) &&
          normalized(typeof a.home === "string" ? a.home : path.join(userHome, ".claude")) ===
            normalized(profile.directory),
      );
      if (!localAccounts.length) continue;
      try {
        const captured = await store.record(profile).catch(() => {
            console.warn(
              "[aster] Claude 프로필 인증을 일시적으로 읽지 못했습니다. 다른 계정은 계속 확인합니다.",
            );
            return { record: null };
          }),
          config = await json(path.join(profile.configDirectory, ".claude.json")),
          oauth = object(config.oauthAccount) ? config.oauthAccount : null;
        const identity = accountIdentity(oauth);
        if (!identity) continue;
        if (captured.record && captured.record.identity !== identity) continue;
        const providerIds = profile.providerIds.filter(
          (id) =>
            providers[id]?.enabled !== false &&
            localAccounts.some((a) => a.id === id) &&
            !authKeys.some((k) => providers[id]?.env?.[k]),
        );
        const metadata = {
          ...(captured.record?.metadata || {}),
          ...(oauth ? { oauthAccount: oauth } : {}),
          accounts: localAccounts
            .filter((a) => providerIds.includes(String(a.id)))
            .map((a) => ({
              id: a.id,
              base: "claude",
              home: null,
              email: typeof a.email === "string" ? a.email : null,
              identity: typeof a.identity === "string" ? a.identity : null,
              signedIn: true,
              ...(typeof a.name === "string" ? { name: a.name } : {}),
            })),
        };
        accounts.push({
          identity,
          providerIds,
          record: captured.record,
          metadata,
          directory: profile.directory,
        });
      } catch {
        console.warn(
          "[aster] Claude 프로필 메타데이터를 확인하지 못해 이 프로필의 인증 전달을 보류합니다.",
        );
      }
    }
    if (
      JSON.stringify(await json(path.join(home, "paseo-accounts", "accounts.json"))) !==
      JSON.stringify(registry)
    )
      throw Error("Aster: 계정 목록이 변경되었습니다. 다음 검사에서 다시 확인합니다.");
    const declined = registered.flatMap((a) => {
      if (a.base !== "claude" || a.signedIn === true || typeof a.identity !== "string") return [];
      const [organization, account] = a.identity.split("|");
      return account ? [hash(["claude", account, organization])] : [];
    });
    // One stale signed-out entry next to a signed-in login of the same account is not a sign-out.
    const signedIn = new Set(accounts.map((account) => account.identity));
    return { providers, accounts, declined: [...new Set(declined)].filter((identity) => !signedIn.has(identity)) };
  }
  /** Registers an account this host has not seen, in the same shape as a local login. */
  async function provision(
    providers: CredentialProviders,
    record: SharedCredential,
    patch: (providers: CredentialProviders) => Promise<void>,
  ) {
    const state = await read(providers);
    if (state.accounts.some((a) => a.identity === record.identity)) return false;
    if (state.declined?.includes(record.identity))
      throw Error("Aster: 이 서버에서 로그아웃한 계정은 자동으로 다시 등록하지 않습니다.");
    const oauth = object(record.metadata.oauthAccount) ? record.metadata.oauthAccount : null;
    if (accountIdentity(oauth) !== record.identity || typeof oauth?.organizationUuid !== "string")
      throw Error("Aster: 등록할 Claude 계정 정보를 확인할 수 없습니다.");
    const email = typeof oauth.emailAddress === "string" ? oauth.emailAddress : null;
    const registry = await json(path.join(home, "paseo-accounts", "accounts.json"));
    const known = (Array.isArray(registry.accounts) ? registry.accounts.filter(object) : []).filter(
      (a) => a.base === "claude" && !!email && a.email === email,
    );
    // A same-address entry without credentials is a local decision (or another organization).
    if (known.length) throw Error("Aster: 같은 주소의 계정이 이미 있어 자동 등록을 보류합니다.");
    const providerId = "claude-" + record.identity.slice(0, 12);
    if (providers[providerId]) throw Error("Aster: 등록할 프로바이더 이름이 이미 사용 중입니다.");
    const id = "claude-" + hash(["provision", record.identity]).slice(0, 24);
    const { accounts: _sourceAccounts, ...metadata } = record.metadata;
    const entry: SharedCredential = {
      ...record,
      id,
      providerIds: [providerId],
      metadata: {
        ...metadata,
        accounts: [
          {
            id: providerId,
            base: "claude",
            home: null,
            email,
            identity: `${oauth.organizationUuid}|${String(oauth.accountUuid)}`,
            signedIn: true,
          },
        ],
      },
    };
    const planned: CredentialProviders = {
      ...providers,
      [providerId]: {
        extends: "claude",
        label: `claude · ${email ?? providerId}`,
        enabled: true,
        selectable: false,
        ...((options.platform ?? process.platform) === "win32"
          ? { env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } }
          : {}),
      },
    };
    const operation = await store.restore(planned, { version: 1, records: [entry] }, providers, {});
    let patched = false;
    try {
      await patch(operation.providers);
      patched = true;
      await operation.commit();
    } catch (error) {
      if (operation.committed) throw error;
      await operation.rollback();
      if (patched) await patch(providers);
      throw error;
    }
    return true;
  }
  async function write(
    providers: CredentialProviders,
    incoming: SharedCredential[],
    patch: (providers: CredentialProviders) => Promise<void>,
    authorize: () => Promise<void> = async () => {},
    /** A login still valid past this moment stays untouched, however new the incoming one is. */
    keepUsableUntil = 0,
    /** Drops the refresh token of the matching profiles instead of delivering a login. */
    release?: (own: CredentialOwnership) => boolean,
  ) {
    const current = await read(providers),
      updates: SharedCredential[] = [];
    const owners = new Map<string, CredentialOwnership>();
    for (const record of incoming) {
      const matches = current.accounts.filter((a) => a.identity === record.identity);
      if (!matches.length) throw Error("Aster: 대상에 등록되지 않은 계정의 인증은 받지 않습니다.");
      for (const own of matches) {
        if (release) {
          if (!release(own)) continue;
        } else {
          if ((own.record?.expiresAt ?? 0) >= (record.expiresAt ?? 0)) continue;
          if (keepUsableUntil && (own.record?.expiresAt ?? 0) > keepUsableUntil) continue;
        }
        // A borrowed access token never costs this host its own login.
        const ownOauth = own.record?.credential.claudeAiOauth;
        const ownRefresh = !release && object(ownOauth) ? ownOauth.refreshToken : undefined;
        const incomingOauth = object(record.credential.claudeAiOauth) ? record.credential.claudeAiOauth : {};
        const delivered = {
          ...record,
          credential: {
            ...record.credential,
            claudeAiOauth: typeof ownRefresh === "string" && ownRefresh ? { ...incomingOauth, refreshToken: ownRefresh } : incomingOauth,
          },
        };
        const leaf = path.basename(own.directory),
          managedRoot = path.join(home, "settings-sync", "provider-profiles");
        const id =
          own.record?.id ??
          (normalized(path.dirname(own.directory)) === normalized(managedRoot) &&
          /^claude-[a-f0-9]{24}$/.test(leaf)
            ? leaf
            : "claude-" + hash([own.identity, randomUUID()]).slice(0, 24));
        const sameDirectory = normalized(own.directory) === normalized(path.join(managedRoot, id));
        const { accounts: registryAccounts, ...metadata } = own.metadata;
        updates.push({
          ...delivered,
          id,
          providerIds: own.providerIds,
          metadata: own.record || sameDirectory ? metadata : own.metadata,
        });
        owners.set(id, own);
      }
    }
    if (!updates.length) return [];
    const verifyRegistry = (own: CredentialOwnership, registry: Record<string, unknown>) => {
      if (!Array.isArray(registry.accounts)) throw Error("Aster: 계정 목록이 변경되었습니다.");
      for (const id of own.providerIds) {
        const account = registry.accounts.find((a: unknown) => object(a) && a.id === id);
        const previous = (own.metadata.accounts as Record<string, unknown>[]).find(
          (a) => a.id === id,
        );
        if (
          !object(account) ||
          account.base !== "claude" ||
          account.signedIn !== true ||
          normalized(
            typeof account.home === "string" ? account.home : path.join(userHome, ".claude"),
          ) !== normalized(own.directory) ||
          account.identity !== previous?.identity ||
          account.email !== previous?.email
        )
          throw Error("Aster: 로그아웃 또는 계정 변경이 확인되어 인증 전달을 중단했습니다.");
      }
    };
    let operation: Awaited<ReturnType<ProviderCredentialSync["restore"]>> | undefined;
    try {
      return await withCredentialLocks(
        store,
        providers,
        [...owners.values()].map((own) => own.directory),
        async () => {
          operation = await store.restore(providers, { version: 1, records: updates }, providers, {
            beforeClaudeWrite: async (incoming) => {
              await authorize();
              const own = owners.get(incoming.id)!;
              verifyRegistry(own, await json(path.join(home, "paseo-accounts", "accounts.json")));
              const original = store
                .profiles(providers)
                .find(
                  (p) =>
                    p.vendor === "claude" &&
                    p.providerIds.some((id) => own.providerIds.includes(id)),
                )!;
              const config = await json(path.join(original.configDirectory, ".claude.json"));
              if (
                accountIdentity(object(config.oauthAccount) ? config.oauthAccount : null) !==
                own.identity
              )
                throw Error("Aster: Claude 로그인 계정이 변경되어 인증 전달을 중단했습니다.");
            },
            beforeClaudeRegistryWrite: async (incoming, raw) => {
              await authorize();
              verifyRegistry(owners.get(incoming.id)!, raw ? JSON.parse(raw) : {});
            },
          });
          let patched = false;
          try {
            if (JSON.stringify(operation.providers) !== JSON.stringify(providers)) {
              await patch(operation.providers);
              patched = true;
            }
            await operation.commit();
          } catch (error) {
            if (operation.committed) throw error;
            await operation.rollback();
            if (patched) await patch(providers);
            throw error;
          }
          return [...new Set(updates.map((r) => r.identity))];
        },
      );
    } catch (error) {
      if (operation?.committed)
        throw Object.assign(
          new Error(
            "Aster: 인증 저장은 완료됐지만 정리 단계에서 오류가 발생했습니다. 갱신된 로그인 경로는 유지했습니다.",
            { cause: error },
          ),
          { credentialCommitted: true },
        );
      throw error;
    }
  }
  return { read, write, provision };
}
