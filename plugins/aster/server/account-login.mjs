import { spawn } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { codexCommand } from "./codex-runtime.mjs";

// This terminal contains only the official CLI login. No tokens cross the plugin RPC.
const options = JSON.parse(process.argv[2]);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
])
  delete env[key];
let command, args;
if (options.base === "codex") {
  env.CODEX_HOME = options.home;
  [command, args] = codexCommand(options.command, [
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
    "--device-auth",
  ]);
} else {
  env.CLAUDE_CONFIG_DIR = options.home;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = options.secureDirectory ?? options.home;
  if (process.platform === "win32") env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
  [command, ...args] = [
    ...options.command,
    "auth",
    "login",
    ...(options.email ? ["--email", options.email] : []),
  ];
}
// npm installs a .cmd shim on Windows, which Node refuses to start without a shell.
const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
let child;
let startError = null;
try {
  child = needsShell
    ? spawn([quote(command), ...args.map(quote)].join(" "), { stdio: "inherit", env, windowsHide: true, shell: true })
    : spawn(command, args, { stdio: "inherit", env, windowsHide: true });
} catch (error) {
  startError = error;
}
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  const temporary = options.done + ".tmp";
  await writeFile(temporary, JSON.stringify({ success: code === 0 }), {
    mode: 0o600,
  });
  await rename(temporary, options.done);
  console.log(
    code === 0
      ? "로그인 완료. Aster가 계정 등록과 구독 확인을 자동으로 진행합니다."
      : "로그인을 완료하지 못했습니다. Aster 설정에서 다시 시도하세요.",
  );
  process.exitCode = code ?? 1;
}
if (startError) {
  console.error("공식 CLI를 실행하지 못했습니다. 설치 경로를 확인하세요.", startError.code ?? "");
  void finish(1);
}
child?.on("error", () => {
  console.error("공식 CLI를 실행하지 못했습니다. 설치 경로를 확인하세요.");
  void finish(1);
});
child?.on("exit", (code) => {
  void finish(code);
});
