import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  codexCommand,
  codexTokens,
  refreshCodexTokens,
} from "./codex-runtime.mjs";

const command = JSON.parse(process.argv[2]),
  args = process.argv.slice(3);
const accountHome = process.env.ASTER_CODEX_ACCOUNT_HOME,
  expected = process.env.ASTER_CODEX_ACCOUNT_ID;
const managed = Boolean(accountHome && expected && args.includes("app-server"));
const childArgs = managed
  ? [...args, "-c", 'cli_auth_credentials_store="ephemeral"']
  : args;
const [file, parameters] = codexCommand(command, childArgs);
const child = spawn(file, parameters, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
const write = (message) => child.stdin.write(JSON.stringify(message) + "\n");
const input = createInterface({ input: process.stdin }),
  output = createInterface({ input: child.stdout });
const loginId = "aster-login-" + randomUUID();
let ready = !managed,
  initializing = false,
  stopped = false,
  timer;
const queued = [];

function fail() {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  for (const message of queued)
    if (message.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          id: message.id,
          error: {
            code: -32000,
            message:
              "Codex 계정 인증을 확인하지 못했습니다. 사용 가능한 다른 계정 또는 계정 로그인을 확인하세요.",
          },
        }) + "\n",
      );
  queued.length = 0;
  process.stderr.write(
    "Aster: Codex 계정 연결에 실패했습니다. 인증 값은 기록하지 않습니다.\n",
  );
  child.kill();
  process.exitCode = 1;
}

async function authenticate() {
  if (initializing) return;
  initializing = true;
  timer = setTimeout(fail, 20000);
  try {
    const tokens = await codexTokens(accountHome, expected);
    write({
      id: loginId,
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken: tokens.accessToken,
        chatgptAccountId: tokens.chatgptAccountId,
        chatgptPlanType: tokens.chatgptPlanType,
      },
    });
  } catch {
    fail();
  }
}

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail();
    return;
  }
  if (!managed || ready) {
    write(message);
    return;
  }
  if (message.method === "initialize") {
    write({
      ...message,
      params: {
        ...message.params,
        capabilities: {
          ...message.params?.capabilities,
          experimentalApi: true,
        },
      },
    });
  } else if (message.method === "initialized") {
    write(message);
    void authenticate();
  } else queued.push(message);
});

output.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail();
    return;
  }
  if (managed && message.id === loginId) {
    if (message.error) {
      fail();
      return;
    }
    clearTimeout(timer);
    ready = true;
    for (const pending of queued.splice(0)) write(pending);
    return;
  }
  if (managed && message.method === "account/chatgptAuthTokens/refresh") {
    const sendError = () =>
      write({
        id: message.id,
        error: {
          code: -32000,
          message: "동일한 Codex 계정의 인증을 갱신하지 못했습니다.",
        },
      });
    if (
      message.params?.previousAccountId &&
      message.params.previousAccountId !== expected
    ) {
      sendError();
      return;
    }
    void refreshCodexTokens(command, accountHome, expected).then(
      (tokens) =>
        write({
          id: message.id,
          result: {
            accessToken: tokens.accessToken,
            chatgptAccountId: tokens.chatgptAccountId,
            chatgptPlanType: tokens.chatgptPlanType,
          },
        }),
      sendError,
    );
    return;
  }
  process.stdout.write(line + "\n");
});
child.stderr.pipe(process.stderr);
child.on("error", fail);
child.stdin.on("error", fail);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  stopped = true;
  input.close();
  output.close();
  process.stdin.pause();
  process.exit(code ?? (signal ? 1 : 0));
});
input.on("close", () => {
  clearTimeout(timer);
  child.stdin.end();
});
process.on("SIGTERM", () => child.kill());
process.on("SIGINT", () => child.kill("SIGINT"));
