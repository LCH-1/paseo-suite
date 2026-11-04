import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, resolve, delimiter } from "node:path";

export function codexCommand(command, args = [], platform = process.platform) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((value) => typeof value !== "string")
  )
    throw Error("Codex 실행 명령이 올바르지 않습니다.");
  let [file, ...prefix] = command;
  if (platform === "win32" && /^codex(?:\.cmd|\.ps1)?$/i.test(file)) {
    const paths = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
    file =
      paths.map((directory) => join(directory, "codex.cmd")).find(existsSync) ??
      file;
  }
  if (platform === "win32" && /\.(?:cmd|ps1)$/i.test(file)) {
    const script = join(
      dirname(file),
      "node_modules/@openai/codex/bin/codex.js",
    );
    if (
      !existsSync(script) ||
      !/^codex\.(cmd|ps1)$/i.test(file.split(/[\\/]/).at(-1))
    )
      throw Error("Codex 공식 CLI 실행 경로를 확인하세요.");
    return [process.execPath, [script, ...prefix, ...args]];
  }
  return [file, [...prefix, ...args]];
}

function claims(token) {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    return {};
  }
}

export async function codexTokens(home, expectedIdentity) {
  if (!isAbsolute(home)) throw Error("Codex 계정 폴더는 절대 경로여야 합니다.");
  const file = join(resolve(home), "auth.json"),
    stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)
    throw Error("Codex 인증 파일을 안전하게 읽을 수 없습니다.");
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw Error("Codex 인증 파일을 확인하세요.");
  }
  const tokens = value?.tokens;
  if (typeof tokens?.access_token !== "string" || !tokens.access_token)
    throw Error("Codex 계정에 다시 로그인하세요.");
  const access = claims(tokens.access_token),
    id = claims(tokens.id_token ?? "");
  const accessAuth = access["https://api.openai.com/auth"] ?? {},
    idAuth = id["https://api.openai.com/auth"] ?? {};
  const accountId =
    tokens.account_id ??
    accessAuth.chatgpt_account_id ??
    idAuth.chatgpt_account_id;
  if (
    typeof accountId !== "string" ||
    !accountId ||
    (expectedIdentity && expectedIdentity !== accountId)
  )
    throw Error(
      "Codex 계정 인증이 다른 계정으로 바뀌었습니다. 계정을 다시 등록하세요.",
    );
  return {
    accessToken: tokens.access_token,
    chatgptAccountId: accountId,
    chatgptPlanType:
      accessAuth.chatgpt_plan_type ?? idAuth.chatgpt_plan_type ?? null,
    expiresAt: typeof access.exp === "number" ? access.exp * 1000 : null,
  };
}

/** Official CLI owns refresh and persistence. This client sends no thread or model requests. */
export class CodexAccountClient {
  constructor(command, home, options = {}) {
    const [file, args] = codexCommand(command, [
      "app-server",
      "--listen",
      "stdio://",
    ]);
    this.child = spawn(file, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...options.env,
        CODEX_HOME: home,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    this.pending = new Map();
    this.next = 0;
    this.closed = false;
    this.timeout = options.timeout ?? 15000;
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(Error("Codex 계정 정보를 확인하지 못했습니다."));
      else pending.resolve(message.result);
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
  }
  fail() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error("Codex 계정 연결이 종료되었습니다."));
    }
    this.pending.clear();
    this.closed = true;
  }
  request(method, params = {}) {
    if (this.closed)
      return Promise.reject(Error("Codex 계정 연결이 종료되었습니다."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Codex 계정 확인 시간이 초과되었습니다."));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "paseo-aster-accounts", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write('{"method":"initialized","params":{}}\n');
  }
  close() {
    this.fail();
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
  }
}

export async function inspectCodexAccount(
  command,
  home,
  expectedIdentity,
  refresh = false,
) {
  let tokens = await codexTokens(home, expectedIdentity);
  const client = new CodexAccountClient(command, home);
  try {
    await client.initialize();
    const needsRefresh =
      refresh ||
      (tokens.expiresAt !== null && tokens.expiresAt < Date.now() + 90000);
    const account = await client.request("account/read", {
      refreshToken: needsRefresh,
    });
    tokens = await codexTokens(home, expectedIdentity);
    if (account?.account?.type !== "chatgpt")
      throw Error("Codex 구독 계정으로 로그인하세요.");
    const limits = await client.request("account/rateLimits/read");
    if (
      limits?.accountId != null &&
      limits.accountId !== tokens.chatgptAccountId
    )
      throw Error("Codex 사용량 계정이 등록한 계정과 다릅니다.");
    const bucket = limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits;
    return {
      tokens,
      plan: bucket?.planType ?? account.account.planType ?? "unknown",
      allowed: limits?.ordinaryUsageAllowed ?? null,
      blocked:
        bucket?.spendControlReached === true ||
        bucket?.rateLimitReachedType != null,
      windows: [bucket?.primary, bucket?.secondary]
        .filter(Boolean)
        .map((window) => ({
          usedPercent: window.usedPercent,
          windowDurationMins: window.windowDurationMins ?? null,
          resetsAt: window.resetsAt == null ? null : window.resetsAt * 1000,
        })),
    };
  } finally {
    client.close();
  }
}

export async function refreshCodexTokens(command, home, expectedIdentity) {
  const client = new CodexAccountClient(command, home, { timeout: 7000 });
  try {
    await client.initialize();
    await codexTokens(home, expectedIdentity);
    await client.request("account/read", { refreshToken: true });
    return await codexTokens(home, expectedIdentity);
  } finally {
    client.close();
  }
}
