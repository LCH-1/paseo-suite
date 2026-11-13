import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import {
  chooseCodexAccount,
  codexBudget,
  hasCodexSubscription,
  type CodexReading,
} from "./codex-policy";
import {
  codexCommand,
  codexTokens,
  inspectCodexAccount,
} from "./codex-runtime.mjs";
import {
  codexNodeLauncher,
  codexLauncherCommand,
  codexOriginalCommand,
  codexReadingReuse,
  discoverCodexAccounts,
  registerCodexRouting,
  removeOldLauncher,
  resumableCodexAccount,
  retryingBridge,
} from "./codex";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";

test("Codex 실행 모듈은 시작 시 실패해도 다음 세션에서 한 번만 다시 준비한다", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const ready = retryingBridge(
    async () => {
      calls++;
      if (calls === 1) throw Error("not listening");
    },
    (error) => errors.push(error),
  );
  assert.deepEqual(await Promise.all([ready(), ready()]), [true, true]);
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.equal(await ready(), true);
  assert.equal(calls, 2);
});

test("Codex 실행 모듈이 계속 실패하면 실패를 알린다", async () => {
  const ready = retryingBridge(
    async () => {
      throw Error("down");
    },
    () => {},
  );
  assert.equal(await ready(), false);
});

test("Codex 실행 모듈은 데몬 준비 전 실패를 알리지 않고 스스로 다시 준비한다", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const ready = retryingBridge(
    async () => {
      if (++calls < 3) throw Error("listen is null");
    },
    (error) => errors.push(error),
    { attempts: 5, retryMs: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 3);
  assert.deepEqual(errors, []);
  assert.equal(await ready(), true);
  assert.equal(calls, 3);
});

test("Codex 실행 모듈 재시도는 해제 후 멈추고 소진되면 실패를 알린다", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const stopped = retryingBridge(
    async () => {
      calls++;
      throw Error("down");
    },
    () => {},
    { attempts: 5, retryMs: 1 },
  );
  stopped.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  retryingBridge(
    async () => {
      throw Error("down");
    },
    (error) => errors.push(error),
    { attempts: 2, retryMs: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(errors.length, 1);
});

test("한도가 없어도 기존 대화는 열리지만 새 세션과 사전 점검은 막힌다", () => {
  const bound = { id: "second", home: "/second", identity: "b" };
  const first = { id: "codex", home: "/codex", identity: "a" };
  assert.equal(
    resumableCodexAccount({ reason: "resume" }, bound, [first]),
    bound,
  );
  assert.equal(
    resumableCodexAccount({ reason: "refresh" }, undefined, [first]),
    first,
  );
  assert.equal(
    resumableCodexAccount({ reason: "resume" }, undefined, []),
    null,
  );
  assert.equal(
    resumableCodexAccount({ reason: "create" }, bound, [first]),
    null,
  );
  assert.equal(
    resumableCodexAccount({ reason: "import" }, bound, [first]),
    null,
  );
  assert.equal(
    resumableCodexAccount({ reason: "resume", preflight: true }, bound, [
      first,
    ]),
    null,
  );
});

const now = 1800000000000;
function reading(id: string, used = 20): CodexReading {
  return {
    id,
    identity: id,
    at: now,
    plan: "pro",
    allowed: true,
    blocked: false,
    windows: [
      { usedPercent: used, windowDurationMins: 300, resetsAt: now + 3600000 },
      {
        usedPercent: used,
        windowDurationMins: 10080,
        resetsAt: now + 86400000,
      },
    ],
  };
}

test("Codex는 한도를 다 쓰지 않았으면 잔여가 적어도 선택하고 더 여유로운 계정을 우선한다", () => {
  const choose = (...readings: CodexReading[]) =>
    chooseCodexAccount({ readings, now, loads: new Map() })?.id ?? null;
  assert.equal(choose(reading("a", 99)), "a");
  assert.equal(choose(reading("a", 99), reading("b", 98)), "b");
  assert.equal(choose(reading("a", 100)), null);
});

test("Codex는 해지 예약이 있어도 현재 유료 플랜이면 사용하고 실제 Free·알수없는 플랜은 제외", () => {
  for (const plan of [
    "go",
    "plus",
    "pro",
    "team",
    "business",
    "enterprise",
    "edu",
  ])
    assert.equal(hasCodexSubscription(plan), true);
  for (const plan of ["free", "unknown", "", "expired"])
    assert.equal(hasCodexSubscription(plan), false);
  assert.equal(
    chooseCodexAccount({
      readings: [{ ...reading("free"), plan: "free" }, reading("paid")],
      now,
      loads: new Map(),
    })?.id,
    "paid",
  );
});

test("Codex는 남은 사용량과 동시 부하를 비교하고 소진·이용거부 계정을 제외", () => {
  assert.equal(
    chooseCodexAccount({
      readings: [reading("small", 80), reading("large", 10)],
      now,
      loads: new Map(),
    })?.id,
    "large",
  );
  assert.equal(
    chooseCodexAccount({
      readings: [reading("a"), reading("b")],
      now,
      loads: new Map([["a", 3]]),
    })?.id,
    "b",
  );
  assert.equal(
    chooseCodexAccount({
      readings: [
        reading("full", 100),
        { ...reading("denied"), allowed: false },
        { ...reading("blocked"), blocked: true },
      ],
      now,
      loads: new Map(),
    }),
    null,
  );
});

test("Codex는 지난 초기화 시각·오래된 보고서·미확인 한도를 여유로 추정하지 않는다", () => {
  const invalid = [
    { ...reading("stale"), at: now - 360001 },
    {
      ...reading("past"),
      windows: [
        { usedPercent: 100, resetsAt: now - 1, windowDurationMins: 300 },
      ],
    },
    { ...reading("missing"), windows: [] },
    {
      ...reading("broken"),
      windows: [
        { usedPercent: Number.NaN, resetsAt: null, windowDurationMins: null },
      ],
    },
  ];
  assert.equal(
    chooseCodexAccount({ readings: invalid, now, loads: new Map() }),
    null,
  );
});

test("같은 계정 별칭은 중복 분배하지 않고 최신 구독종료 보고서가 예전 정상값보다 우선", () => {
  const old = reading("alias-a"),
    denied = {
      ...reading("alias-b"),
      identity: "alias-a",
      plan: "free",
      at: now + 1,
    };
  assert.equal(
    chooseCodexAccount({
      readings: [old, denied],
      now: now + 1,
      loads: new Map(),
    }),
    null,
  );
  const renewed = { ...reading("alias-b"), identity: "alias-a", at: now + 2 };
  assert.equal(
    chooseCodexAccount({
      readings: [denied, renewed],
      now: now + 2,
      loads: new Map(),
    })?.id,
    "alias-b",
  );
});

test("Codex는 잦은 계정 교체를 막고 현재 계정이 소진되면 유지시간 없이 전환", () => {
  const current = { identity: "a", switchedAt: now - 1000 };
  assert.equal(
    chooseCodexAccount({
      readings: [reading("a", 70), reading("b", 10)],
      now,
      loads: new Map(),
      current,
    })?.id,
    "a",
  );
  assert.equal(
    chooseCodexAccount({
      readings: [reading("a", 100), reading("b", 10)],
      now,
      loads: new Map(),
      current,
    })?.id,
    "b",
  );
});

async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-accounts-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function tokenFile(home: string, identity: string) {
  await mkdir(home, { recursive: true });
  const access =
    "fixture." +
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url") +
    ".token";
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: access, account_id: identity } }),
  );
  return access;
}

test("Windows 공식 Codex 실행기의 하위 프로세스도 창을 숨기고 인자·환경을 보존한다", async () =>
  fixture(async (home) => {
    const bin = join(home, "node_modules/@openai/codex/bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(home, "node_modules/@openai/codex/package.json"),
      '{"type":"module"}',
    );
    const script = join(bin, "codex.js"),
      shim = join(home, "codex.cmd");
    await writeFile(shim, "@echo off\r\n");
    await writeFile(
      script,
      `import {spawn,ChildProcess} from 'node:child_process';
ChildProcess.prototype.spawn=function(options){console.log(JSON.stringify({windowsHide:options.windowsHide,args:process.argv.slice(2),environment:process.env.ASTER_WINDOW_FIXTURE,stdio:options.stdio}));return this;};
spawn('owned-fixture-does-not-exist',[],{stdio:['pipe','pipe','pipe'],windowsHide:false});`,
    );
    const [command, args] = codexCommand(
      [shim, "prefix with spaces"],
      ["app-server"],
      "win32",
    );
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ASTER_WINDOW_FIXTURE: "preserved",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (value) => (output += value));
    child.stderr.on("data", (value) => (errors += value));
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.on("error", reject);
      child.on("close", resolveExit);
    });
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), {
      windowsHide: true,
      args: ["prefix with spaces", "app-server"],
      environment: "preserved",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.deepEqual(
      codexCommand(
        [process.execPath, "custom-wrapper.js"],
        ["app-server"],
        "win32",
      ),
      [process.execPath, ["custom-wrapper.js", "app-server"]],
    );
    assert.deepEqual(codexCommand([shim], ["app-server"], "linux"), [
      shim,
      ["app-server"],
    ]);
  }));

test("다중 계정은 인증 폴더별로 발견하고 같은 실제 계정 별칭은 하나로 합친다", async () =>
  fixture(async (home) => {
    const first = join(home, "first"),
      second = join(home, "second");
    await tokenFile(first, "account-a");
    await tokenFile(second, "account-b");
    const result = await discoverCodexAccounts(
      {
        codex: { env: { CODEX_HOME: first } },
        "codex-two": { extends: "codex", env: { CODEX_HOME: second } },
        "codex-duplicate": { extends: "codex", env: { CODEX_HOME: first } },
      },
      join(home, "paseo"),
      home,
    );
    assert.deepEqual(result.map((account) => account.identity).sort(), [
      "account-a",
      "account-b",
    ]);
    await assert.rejects(codexTokens(first, "account-b"), /다른 계정/);
  }));

test("같은 Codex 계정에 다시 로그인하면 오래된 기본 인증보다 최신 등록 인증을 사용", async () =>
  fixture(async (home) => {
    const oldHome = join(home, "old"),
      freshHome = join(home, "fresh");
    await tokenFile(oldHome, "same-account");
    await tokenFile(freshHome, "same-account");
    await utimes(join(oldHome, "auth.json"), 100, 100);
    await utimes(join(freshHome, "auth.json"), 200, 200);
    const accounts = await discoverCodexAccounts(
      {
        codex: { env: { CODEX_HOME: oldHome } },
        "codex-renewed": { extends: "codex", env: { CODEX_HOME: freshHome } },
      },
      join(home, "paseo"),
      home,
    );
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].home, freshHome);
  }));

const fakeServer = `
const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path');let loggedIn=false,refreshRequest;
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
const stateFile=path.join(process.env.CODEX_HOME,'fixture-state.json');const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
if(m.method==='fixture/refresh'){refreshRequest=m.id;process.stdout.write(JSON.stringify({id:'fixture-private-refresh',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:m.params.account}})+'\\n');return;}
if(m.id==='fixture-private-refresh'){process.stdout.write(JSON.stringify({id:refreshRequest,result:{accepted:!m.error,identity:m.result?.chatgptAccountId}})+'\\n');return;}
if(m.method==='account/login/start'){loggedIn=m.params.type==='chatgptAuthTokens';result={type:'chatgptAuthTokens'};}
if(m.method==='account/read')result={account:{type:'chatgpt',planType:state.plan??'pro'}};
if(m.method==='account/rateLimits/read')result={accountId:state.identity??'account-a',rateLimits:{planType:state.plan??'pro',primary:{usedPercent:state.used??23,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}},ordinaryUsageAllowed:state.allowed??true};
if(m.method==='thread/resume')result={thread:m.params.threadId,home:process.env.CODEX_HOME,loggedIn,ephemeral:process.argv.includes('cli_auth_credentials_store="ephemeral"')};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`;

test("Electron 실행 launcher는 환경변수를 직접 설정하고 경로를 이스케이프한다", () => {
  const launcher = codexNodeLauncher("C:\\앱 100%'\\Paseo.exe", "win32");
  assert.equal(launcher.file, "codex-node.ps1");
  assert.ok(
    launcher.content.includes("$start.FileName = 'C:\\앱 100%''\\Paseo.exe'"),
  );
  assert.ok(
    launcher.content.includes(
      '$start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"',
    ),
  );
  // No per-launch C# build, and nothing that stops the child inheriting the daemon's pipes.
  assert.doesNotMatch(launcher.content, /Add-Type|Redirect|CreateNoWindow/);
  assert.equal(
    codexNodeLauncher("/opt/it's/Paseo", "linux").content,
    "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/it'\\''s/Paseo' \"$@\"\n",
  );
});

test(
  "launcher는 제거된 환경변수를 복원하고 JSON 인자·stdin·종료 코드를 전달한다",
  { skip: process.platform !== "win32" },
  async () =>
    fixture(async (home) => {
      const launcher = codexNodeLauncher(process.execPath),
        file = join(home, launcher.file),
        script = join(home, "print.cjs");
      await writeFile(file, launcher.content);
      await writeFile(
        script,
        `process.stdin.once("data",(d)=>{console.log(JSON.stringify({args:process.argv.slice(2),env:process.env.ELECTRON_RUN_AS_NODE,input:String(d).trim()}));process.exit(7)});`,
      );
      const original = JSON.stringify(["C:\\Program Files\\npm\\codex.cmd"]);
      const extra = [
        "",
        "한글 & %PATH% ! ^ | < > ( )",
        'quote"\\',
        "trailing\\\\",
        "line\nnext",
      ];
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const [command, ...prefix] = codexLauncherCommand(file);
      const child = spawnProcess(
        command,
        [...prefix, script, original, "app-server", ...extra],
        {
          stdio: "pipe",
          env,
        },
      );
      let output = "";
      let error = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (error += data));
      child.stdin.write("ping\n");
      const code = await new Promise((accept) => child.on("close", accept));
      assert.equal(code, 7, error);
      assert.deepEqual(JSON.parse(output), {
        args: [original, "app-server", ...extra],
        env: "1",
        input: "ping",
      });
    }),
);

test("배치 실행기와 PowerShell 실행기 설정에서 원래 Codex 명령을 복원한다", () => {
  const proxy = "C:\\앱\\server\\codex-proxy.mjs";
  const original = ["C:\\Program Files\\npm\\codex.cmd"];
  for (const prefix of [
    ["C:\\old\\codex-node.cmd"],
    codexLauncherCommand("C:\\새 폴더\\codex-node.ps1", "win32"),
  ]) {
    assert.deepEqual(
      codexOriginalCommand([...prefix, proxy, JSON.stringify(original)]),
      original,
    );
  }
});

test(
  "배치 없는 실행기는 연속 JSON과 EOF·stderr를 보존하고 중단 종료 코드로 즉시 닫힌다",
  { skip: process.platform !== "win32", timeout: 10000 },
  async () =>
    fixture(async (home) => {
      const directory = join(home, "한글 ' & 100%");
      await mkdir(directory);
      const launcher = codexNodeLauncher(process.execPath);
      const file = join(directory, launcher.file),
        script = join(directory, "echo.cjs");
      await writeFile(file, launcher.content);
      await writeFile(
        script,
        `const r=require("node:readline").createInterface({input:process.stdin}); r.on("line", line=>process.stdout.write(line+"\\n")); r.on("close",()=>{process.stderr.write("종료 확인\\n");process.exitCode=130;});`,
      );
      const [command, ...prefix] = codexLauncherCommand(file);
      const child = spawnProcess(command, [...prefix, script], {
        stdio: "pipe",
      });
      const output = createInterface({ input: child.stdout });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = new Promise((resolve) => child.on("close", resolve));
      const messages = output[Symbol.asyncIterator]();
      const first = JSON.stringify({ id: 1, text: "한글 λ 🚀" });
      child.stdin.write(first + "\n");
      assert.equal((await messages.next()).value, first);
      const second = JSON.stringify({ id: 2, text: "x".repeat(100000) });
      child.stdin.end(second + "\n");
      assert.equal((await messages.next()).value, second);
      assert.equal(await closed, 130);
      assert.equal(stderr, "종료 확인\n");
      assert.equal((await messages.next()).done, true);
    }),
);

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitUntil(done: () => boolean, timeout = 5000) {
  const until = Date.now() + timeout;
  while (!done() && Date.now() < until)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  return done();
}
async function launchThroughLauncher(
  home: string,
  args: string[],
  overlay: NodeJS.ProcessEnv = {},
) {
  const launcher = codexNodeLauncher(process.execPath),
    file = join(home, launcher.file);
  await writeFile(file, launcher.content);
  const env = { ...process.env, ...overlay };
  delete env.ELECTRON_RUN_AS_NODE;
  const [command, ...prefix] = codexLauncherCommand(file);
  // The daemon starts provider commands through this same helper.
  return spawnProcess(command, [...prefix, ...args], { stdio: "pipe", env });
}

test(
  "실행기는 RPC 입력을 가로채지 않고 Codex가 Ctrl+C 코드로 사라지면 같은 코드로 즉시 끝난다",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () =>
    fixture(async (home) => {
      const script = join(home, "echo-until-quit.cjs");
      await writeFile(
        script,
        `require("node:readline").createInterface({input:process.stdin}).on("line",line=>{if(line==="quit")process.exit(0xC000013A);process.stdout.write(line+"\\n");});`,
      );
      const child = await launchThroughLauncher(home, [script]);
      const received: string[] = [];
      createInterface({ input: child.stdout }).on("line", (line) =>
        received.push(line),
      );
      child.stderr.resume();
      const closed = new Promise((accept) => child.on("close", accept));
      // Written before PowerShell has started: the launcher shares this pipe and must not read it.
      const sent = Array.from({ length: 500 }, (_, id) =>
        JSON.stringify({ id, text: "한글 λ 🚀 " + "x".repeat(id) }),
      );
      child.stdin.write(sent.join("\n") + "\n");
      assert.equal(
        await waitUntil(() => received.length === sent.length),
        true,
      );
      assert.deepEqual(received, sent);
      // stdin stays open, as it did when the batch launcher stopped at its Y/N prompt.
      child.stdin.write("quit\n");
      assert.equal(await closed, 0xc000013a);
    }),
);

test(
  "실행기만 강제 종료돼도 자식은 stdin 종료로 끝나고 프로세스 트리 종료는 자식까지 정리한다",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () =>
    fixture(async (home) => {
      const script = join(home, "wait.cjs"),
        marker = join(home, "stdin-ended");
      await writeFile(
        script,
        `console.log(process.pid);
if(process.argv[2])process.stdin.on("end",()=>{require("node:fs").writeFileSync(process.argv[2],"");process.exit(0);}).resume();
else setInterval(()=>{},1000);`,
      );
      const start = async (...args: string[]) => {
        const child = await launchThroughLauncher(home, [script, ...args]);
        child.stderr.resume();
        const [line] = await once(
          createInterface({ input: child.stdout }),
          "line",
        );
        return { child, pid: Number(line) };
      };
      const pids: number[] = [];
      try {
        const alone = await start(marker);
        pids.push(alone.pid);
        alone.child.kill();
        assert.equal(await waitUntil(() => existsSync(marker)), true);
        assert.equal(await waitUntil(() => !processAlive(alone.pid)), true);

        // This child ignores stdin, so only the tree kill can end it.
        const tree = await start();
        pids.push(tree.pid);
        // The daemon stops a Codex session with the same taskkill /T /F tree kill.
        await terminateProcess(tree.child);
        assert.equal(await waitUntil(() => !processAlive(tree.pid)), true);
      } finally {
        for (const pid of pids) if (processAlive(pid)) process.kill(pid);
      }
    }),
);

test(
  "실행기와 인증 브리지를 함께 거쳐도 요청·EOF·종료 코드가 끝까지 이어진다",
  { skip: process.platform !== "win32", timeout: 15000 },
  async () =>
    fixture(async (home) => {
      const account = join(home, "account"),
        shared = join(home, "shared"),
        script = join(home, "fake.cjs");
      const token = await tokenFile(account, "account-a");
      await writeFile(script, fakeServer);
      const child = await launchThroughLauncher(
        home,
        [
          join(import.meta.dirname, "codex-proxy.mjs"),
          JSON.stringify([process.execPath, script]),
          "app-server",
        ],
        {
          CODEX_HOME: shared,
          ASTER_CODEX_ACCOUNT_HOME: account,
          ASTER_CODEX_ACCOUNT_ID: "account-a",
        },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.resume();
      const closed = new Promise((accept) => child.on("close", accept));
      const messages = createInterface({ input: child.stdout })[
        Symbol.asyncIterator
      ]();
      const send = (message: object) =>
        child.stdin.write(JSON.stringify(message) + "\n");
      const reply = async () =>
        JSON.parse(String((await messages.next()).value));
      send({ id: 1, method: "initialize", params: {} });
      assert.equal((await reply()).id, 1);
      send({ method: "initialized", params: {} });
      send({
        id: 2,
        method: "thread/resume",
        params: { threadId: "existing-thread" },
      });
      assert.deepEqual(await reply(), {
        id: 2,
        result: {
          thread: "existing-thread",
          home: shared,
          loggedIn: true,
          ephemeral: true,
        },
      });
      child.stdin.end();
      assert.equal(await closed, 0);
      assert.equal(output.includes(token), false);
    }),
);

test("공식 app-server 계정 조회는 모델 요청 없이 현재 플랜·한도를 읽는다", async () =>
  fixture(async (home) => {
    const script = join(home, "fake.cjs");
    await writeFile(script, fakeServer);
    await tokenFile(home, "account-a");
    const value = await inspectCodexAccount(
      [process.execPath, script],
      home,
      "account-a",
    );
    assert.equal(value.plan, "pro");
    assert.equal(value.allowed, true);
    assert.equal(value.windows[0].usedPercent, 23);
  }));

test("두 Codex 인증 폴더의 공식 RPC 결과로 부하 분산·구독 종료 제외·재구독 복귀를 이어서 처리", async () =>
  fixture(async (home) => {
    const first = join(home, "first"),
      second = join(home, "second");
    const script = join(home, "fake.cjs");
    await writeFile(script, fakeServer);
    await tokenFile(first, "account-a");
    await tokenFile(second, "account-b");
    const state = async (
      directory: string,
      identity: string,
      plan: string,
      used: number,
      allowed = true,
    ) =>
      writeFile(
        join(directory, "fixture-state.json"),
        JSON.stringify({ identity, plan, used, allowed }),
      );
    await state(first, "account-a", "pro", 80);
    await state(second, "account-b", "pro", 10);
    const accounts = await discoverCodexAccounts(
      {
        codex: { env: { CODEX_HOME: first } },
        "codex-second": { extends: "codex", env: { CODEX_HOME: second } },
      },
      join(home, "paseo"),
      home,
    );
    assert.equal(accounts.length, 2);
    const instant = Date.now();
    const read = async (at: number): Promise<CodexReading[]> =>
      Promise.all(
        accounts.map(async (account) => {
          const value = await inspectCodexAccount(
            [process.execPath, script],
            account.home,
            account.identity,
          );
          return {
            id: account.id,
            identity: account.identity,
            at,
            plan: value.plan,
            allowed: value.allowed,
            windows: value.windows,
            blocked: value.blocked,
          };
        }),
      );
    const initial = await read(instant);
    assert.equal(
      chooseCodexAccount({ readings: initial, now: instant, loads: new Map() })
        ?.identity,
      "account-b",
    );
    assert.equal(
      chooseCodexAccount({
        readings: initial,
        now: instant,
        loads: new Map([["account-b", 100]]),
      })?.identity,
      "account-a",
    );

    await state(first, "account-a", "free", 0);
    const lapsed = await read(instant + 1);
    assert.equal(
      chooseCodexAccount({
        readings: lapsed,
        now: instant + 1,
        loads: new Map(),
        current: { identity: "account-a", switchedAt: instant },
      })?.identity,
      "account-b",
    );

    await state(second, "account-b", "pro", 10, false);
    assert.equal(
      chooseCodexAccount({
        readings: await read(instant + 2),
        now: instant + 2,
        loads: new Map(),
      }),
      null,
    );

    await state(first, "account-a", "pro", 5);
    assert.equal(
      chooseCodexAccount({
        readings: [...lapsed, ...(await read(instant + 3))],
        now: instant + 3,
        loads: new Map(),
      })?.identity,
      "account-a",
    );
  }));

test("Codex 인증 갱신은 같은 계정만 허용하고 토큰과 내부 갱신 RPC를 노출하지 않는다", async () =>
  fixture(async (home) => {
    const account = join(home, "account"),
      script = join(home, "fake.cjs");
    const token = await tokenFile(account, "account-a");
    await writeFile(script, fakeServer);
    for (const requested of ["account-a", "account-b"]) {
      const child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "codex-proxy.mjs"),
          JSON.stringify([process.execPath, script]),
          "app-server",
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CODEX_HOME: home,
            ASTER_CODEX_ACCOUNT_HOME: account,
            ASTER_CODEX_ACCOUNT_ID: "account-a",
          },
        },
      );
      const output = await new Promise<string>((accept, reject) => {
        let output = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("refresh timed out"));
        }, 10000);
        child.stderr.resume();
        child.on("error", reject);
        child.stdout.on("data", (data) => {
          output += data;
          if (
            output.split("\n").some((line) => line && JSON.parse(line).id === 3)
          ) {
            clearTimeout(timer);
            child.stdin.end();
            accept(output);
          }
        });
        child.stdin.write(
          JSON.stringify({ id: 1, method: "initialize", params: {} }) +
            "\n" +
            JSON.stringify({ method: "initialized", params: {} }) +
            "\n" +
            JSON.stringify({
              id: 3,
              method: "fixture/refresh",
              params: { account: requested },
            }) +
            "\n",
        );
      });
      assert.equal(output.includes(token), false);
      assert.equal(output.includes("fixture-private-refresh"), false);
      const response = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 3);
      assert.equal(response.result.accepted, requested === "account-a");
      assert.equal(
        response.result.identity,
        requested === "account-a" ? "account-a" : undefined,
      );
    }
  }));

test("인증 브리지는 기록 경로와 대화 ID를 유지하며 토큰을 부모 프로세스에 노출하지 않는다", async () =>
  fixture(async (home) => {
    const account = join(home, "account"),
      shared = join(home, "shared"),
      script = join(home, "fake.cjs");
    const token = await tokenFile(account, "account-a");
    await writeFile(script, fakeServer);
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "codex-proxy.mjs"),
        JSON.stringify([process.execPath, script]),
        "app-server",
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_HOME: shared,
          ASTER_CODEX_ACCOUNT_HOME: account,
          ASTER_CODEX_ACCOUNT_ID: "account-a",
        },
      },
    );
    const output = await new Promise<string>((resolveOutput, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("proxy timed out"));
      }, 10000);
      child.on("error", reject);
      child.stderr.resume();
      child.stdout.on("data", (data) => {
        output += data;
        if (
          output.split("\n").some((line) => line && JSON.parse(line).id === 2)
        ) {
          clearTimeout(timer);
          child.stdin.end();
          resolveOutput(output);
        }
      });
      child.stdin.write(
        JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({ method: "initialized", params: {} }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({
          id: 2,
          method: "thread/resume",
          params: { threadId: "existing-thread" },
        }) + "\n",
      );
    });
    assert.equal(output.includes(token), false);
    const response = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);
    assert.deepEqual(response.result, {
      thread: "existing-thread",
      home: shared,
      loggedIn: true,
      ephemeral: true,
    });
    assert.deepEqual(
      codexOriginalCommand([
        process.execPath,
        join(import.meta.dirname, "codex-proxy.mjs"),
        JSON.stringify([process.execPath, script]),
      ]),
      [process.execPath, script],
    );
  }));

const codexWindow = (
  used: number,
  minutes: number | null,
  hours: number | null,
) => ({
  usedPercent: used,
  windowDurationMins: minutes,
  resetsAt: hours === null ? null : now + hours * 3_600_000,
});

test("Codex 점수도 창 개수와 무관하게 남은 사용량 ÷ 초기화까지 남은 시간의 최솟값이라 주간만·5시간+주간·섞인 계정을 같은 방식으로 비교한다", () => {
  const weeklyOnly = {
    ...reading("weekly"),
    windows: [codexWindow(40, 10080, 60)],
  };
  const both = {
    ...reading("both"),
    windows: [codexWindow(50, 300, 2), codexWindow(40, 10080, 60)],
  };
  assert.equal(codexBudget(weeklyOnly, now), 60 / 60);
  assert.equal(codexBudget(both, now), Math.min(50 / 2, 60 / 60));
  const tight = {
    ...reading("tight"),
    windows: [codexWindow(99, 300, 4), codexWindow(40, 10080, 60)],
  };
  assert.equal(codexBudget(tight, now), 1 / 4);
  // Mixed accounts: the five-hour window counts where it exists and binds.
  assert.equal(
    chooseCodexAccount({ readings: [tight, weeklyOnly], now, loads: new Map() })
      ?.id,
    "weekly",
  );
  assert.equal(
    chooseCodexAccount({
      readings: [
        both,
        { ...weeklyOnly, windows: [codexWindow(80, 10080, 60)] },
      ],
      now,
      loads: new Map(),
    })?.id,
    "both",
  );
  // A window without a reset runs for its whole length.
  assert.equal(
    codexBudget(
      { ...reading("fresh"), windows: [codexWindow(0, 300, null)] },
      now,
    ),
    100 / 5,
  );
});

test("Codex 창에 초기화 시각과 길이가 모두 없으면 남은 %를 시간당 속도처럼 쓰지 않고 점수를 만들지 않는다", () => {
  const unknown = {
    ...reading("unknown"),
    windows: [codexWindow(0, null, null)],
  };
  assert.equal(codexBudget(unknown, now), null);
  const partial = {
    ...reading("partial"),
    windows: [...reading("partial").windows, codexWindow(10, null, null)],
  };
  assert.equal(codexBudget(partial, now), null);
  assert.equal(
    chooseCodexAccount({
      readings: [unknown, reading("measured", 90)],
      now,
      loads: new Map(),
    })?.id,
    "measured",
  );
  assert.equal(
    codexBudget(
      {
        ...reading("broken"),
        windows: [{ ...codexWindow(10, 300, null), resetsAt: Number.NaN }],
      },
      now,
    ),
    null,
  );
});

/** The Codex routing hooks with every host, CLI and settings dependency replaced. */
function codexRouting(
  accounts: { id: string; home: string; identity: string }[],
) {
  let clock = now;
  const lookups: Array<{
    identity: string;
    answer: (value: Omit<CodexReading, "id" | "identity" | "at">) => void;
    fail: (error: Error) => void;
  }> = [];
  type Open = (
    input: { request: PluginSessionOpenRequest },
    context: unknown,
  ) => Promise<PluginSessionOpenRequest | undefined>;
  type Listener = (event: unknown, context: unknown) => unknown;
  let hook: Open | null = null;
  const listeners = new Map<string, Listener>();
  /** What `paseo agent reload` does in the host: the hook opens the session again. */
  let reload: (agentId: string) => Promise<void> = async () => {};
  /** The status the host reports for a session after its turn. */
  let status = "idle";
  const routes = registerCodexRouting(
    {
      before: (_name: string, handler: Open) => {
        hook = handler;
        return () => {};
      },
      on: (name: string, handler: Listener) => {
        listeners.set(name, handler);
        return () => {};
      },
    } as never,
    {
      discover: async () => accounts,
      installBridge: async () => {},
      settings: async () => ({ capacities: {} }),
      now: () => clock,
      retention: false,
      reload: (agentId) => reload(agentId),
      inspect: (_command, _home, identity) =>
        new Promise((resolve, reject) => {
          lookups.push({ identity, answer: resolve, fail: reject });
        }),
    },
  );
  const context = {
    signal: new AbortController().signal,
    paseo: {
      config: { get: async () => ({ config: { providers: { codex: {} } } }) },
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { status, pendingPermissions: [] } }),
        }),
      },
    },
  };
  const logs: string[] = [];
  const info = console.info,
    warn = console.warn;
  console.info = (message: string) => void logs.push(message);
  console.warn = (message: string) => void logs.push(message);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  /** Settles every open lookup of `identity`, once one has started. */
  const settle = async (
    identity: string,
    outcome: (lookup: (typeof lookups)[number]) => void,
  ) => {
    for (
      let turn = 0;
      turn < 20 && !lookups.some((lookup) => lookup.identity === identity);
      turn++
    )
      await tick();
    for (const lookup of lookups.filter(
      (entry) => entry.identity === identity,
    )) {
      lookups.splice(lookups.indexOf(lookup), 1);
      outcome(lookup);
    }
    for (let turn = 0; turn < 5; turn++) await tick();
  };
  return {
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Lookups started and not yet answered. */
    waiting: () => lookups.map((lookup) => lookup.identity).sort(),
    /**
     * Answers every open lookup of `identity`: `used` percent spent in both windows, on a paid plan
     * Codex allows unless `access` says otherwise.
     */
    answer: (
      identity: string,
      used: number,
      access: { plan?: string; allowed?: boolean | null } = {},
    ) =>
      settle(identity, (lookup) =>
        lookup.answer({
          plan: access.plan ?? "pro",
          allowed: access.allowed === undefined ? true : access.allowed,
          blocked: used >= 100,
          windows: [
            {
              usedPercent: used,
              windowDurationMins: 300,
              resetsAt: clock + 3_600_000,
            },
            {
              usedPercent: used,
              windowDurationMins: 10080,
              resetsAt: clock + 86_400_000,
            },
          ],
        }),
      ),
    /** Fails every open lookup of `identity`, as a lost login or an app-server error does. */
    fail: (identity: string) =>
      settle(identity, (lookup) =>
        lookup.fail(Error("Codex 계정 정보를 확인하지 못했습니다.")),
      ),
    open: (agentId: string, reason: PluginSessionOpenRequest["reason"]) =>
      hook!(
        {
          request: {
            agentId,
            workspaceId: null,
            provider: "codex",
            cwd: "/workspace",
            reason,
            purpose: "interactive",
            env: {},
          },
        },
        context,
      ),
    /** One turn of `agentId`, ended as `outcome`; resolves once the turn-end handling is done. */
    turn: async (
      agentId: string,
      outcome:
        | { kind: "completed" }
        | { kind: "failed"; error: { message: string } },
    ) => {
      const agent = { id: agentId, provider: "codex" };
      await listeners.get("agent.turn_started")!(
        { agent, turnId: `${agentId}-turn` },
        context,
      );
      return listeners.get("agent.turn_ended")!(
        { agent, turnId: `${agentId}-turn`, outcome },
        context,
      );
    },
    onReload: (action: (agentId: string) => Promise<void>) => {
      reload = action;
    },
    reportStatus: (value: string) => {
      status = value;
    },
    dispose: () => {
      console.info = info;
      console.warn = warn;
      routes.dispose();
    },
  };
}
/** Whether the open answers while every lookup it could wait for is unanswered. */
const answersAtOnce = async (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
const openedOn = (opened: PluginSessionOpenRequest | undefined) =>
  opened?.env.ASTER_CODEX_ACCOUNT_ID;

test("Codex 판독 재사용 한도는 6분 폐기 기준보다 짧고 계정이 여럿이면 더 짧다", () => {
  assert.equal(codexReadingReuse(1), 300_000);
  assert.equal(codexReadingReuse(2), 120_000);
  assert.ok(codexReadingReuse(1) < 360_000);
});

test("Codex 계정이 하나면 재개는 판독을 기다리지 않고 새 대화는 5분 안 판독을 재사용하며 열기 소요를 한 줄 남긴다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/codex", identity: "a" },
  ]);
  try {
    // Never read: a new conversation waits for the official lookup.
    const first = routing.open("first", "create");
    assert.equal(await answersAtOnce(first), false);
    await routing.answer("a", 20);
    assert.equal(openedOn(await first), "a");
    assert.match(
      routing.logs.at(-1)!,
      /^\[aster\] Codex 계정 확인 first \d+ms \(create · 판독 대기 · codex\)$/,
    );

    // Four minutes later the reading still chooses, and is renewed behind the open.
    routing.advance(4 * 60_000);
    const second = routing.open("second", "create");
    assert.equal(await answersAtOnce(second), true);
    assert.equal(openedOn(await second), "a");
    assert.match(
      routing.logs.at(-1)!,
      /second \d+ms \(create · 최근 판독 · codex\)/,
    );
    assert.deepEqual(routing.waiting(), ["a"]);

    // A resume goes back to the only account whatever the readings say.
    routing.advance(10 * 60_000);
    const resumed = routing.open("third", "resume");
    assert.equal(await answersAtOnce(resumed), true);
    assert.equal(openedOn(await resumed), "a");
    assert.match(
      routing.logs.at(-1)!,
      /third \d+ms \(resume · 유일 계정 · codex\)/,
    );
    assert.deepEqual(routing.waiting(), ["a"]);

    // Past five minutes a new conversation waits again, on the lookup already running.
    const late = routing.open("fourth", "create");
    assert.equal(await answersAtOnce(late), false);
    await routing.answer("a", 30);
    assert.equal(openedOn(await late), "a");

    // A recent reading that would refuse never refuses: the open waits for a new one.
    routing.advance(90_000);
    await routing.open("spending", "create");
    await routing.answer("a", 100);
    // Past a minute the spent reading is renewed instead of refusing the new conversation.
    routing.advance(61_000);
    const spent = routing.open("fifth", "create");
    assert.equal(await answersAtOnce(spent), false);
    await routing.answer("a", 10);
    assert.equal(openedOn(await spent), "a");
  } finally {
    routing.dispose();
  }
});

test("Codex 계정이 여럿이면 2분 안 판독만 재사용해 분배하고 묵은 판독과 한도 근처 기존 계정은 새 판독을 기다린다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
  ]);
  try {
    const first = routing.open("one", "create");
    assert.equal(await answersAtOnce(first), false);
    await routing.answer("a", 80);
    await routing.answer("b", 10);
    assert.equal(openedOn(await first), "b");

    // Within two minutes the readings choose at once and are renewed behind the open.
    routing.advance(90_000);
    const second = routing.open("two", "create");
    assert.equal(await answersAtOnce(second), true);
    assert.equal(openedOn(await second), "b");
    assert.deepEqual(routing.waiting(), ["a", "b"]);

    // Past two minutes the old readings would still send it to b, which another client has
    // just spent: the open waits, and the new readings send it to a.
    routing.advance(60_000);
    const third = routing.open("three", "create");
    assert.equal(await answersAtOnce(third), false);
    await routing.answer("a", 80);
    await routing.answer("b", 100);
    assert.equal(openedOn(await third), "a");

    // A resume of a session bound to b, last seen spent, waits and moves to a as before.
    routing.advance(3 * 60_000);
    const moved = routing.open("one", "resume");
    assert.equal(await answersAtOnce(moved), false);
    await routing.answer("a", 80);
    await routing.answer("b", 100);
    assert.equal(openedOn(await moved), "a");

    // A resume of a session bound to a, last seen with room, opens there at once.
    routing.advance(3 * 60_000);
    const kept = routing.open("three", "resume");
    assert.equal(await answersAtOnce(kept), true);
    assert.equal(openedOn(await kept), "a");
    assert.match(
      routing.logs.at(-1)!,
      /three \d+ms \(resume · 기존 계정 · codex\)/,
    );
    assert.deepEqual(routing.waiting(), ["a", "b"]);

    // A resume with no binding left (as after a restart) waits to choose among the accounts.
    const unbound = routing.open("unknown", "resume");
    assert.equal(await answersAtOnce(unbound), false);
    await routing.answer("a", 80);
    await routing.answer("b", 20);
    assert.equal(openedOn(await unbound), "b");
  } finally {
    routing.dispose();
  }
});

test("Codex 계정이 여럿이면 차단 전이어도 90% 이상 쓴 것으로 마지막에 본 기존 계정으로는 바로 재개하지 않고 새 판독을 기다려 여유 계정으로 옮긴다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
  ]);
  try {
    const first = routing.open("s", "create");
    await routing.answer("a", 10);
    await routing.answer("b", 50);
    assert.equal(openedOn(await first), "a");

    // Past the ten-minute hold another open finds a nearly spent, though not blocked yet.
    routing.advance(11 * 60_000);
    const other = routing.open("other", "create");
    await routing.answer("a", 95);
    await routing.answer("b", 10);
    assert.equal(openedOn(await other), "b");

    // Three minutes on, the old reading would send the resume back to a: it waits instead.
    routing.advance(3 * 60_000);
    const resumed = routing.open("s", "resume");
    assert.equal(await answersAtOnce(resumed), false);
    await routing.answer("a", 95);
    await routing.answer("b", 10);
    assert.equal(openedOn(await resumed), "b");
    assert.match(
      routing.logs.at(-1)!,
      /s \d+ms \(resume · 판독 대기 · codex-second\)$/,
    );

    // Just under the line the bound account still takes the resume at once.
    routing.advance(11 * 60_000);
    const third = routing.open("third", "create");
    await routing.answer("a", 10);
    await routing.answer("b", 89);
    assert.equal(openedOn(await third), "a");
    routing.advance(3 * 60_000);
    const kept = routing.open("s", "resume");
    assert.equal(await answersAtOnce(kept), true);
    assert.equal(openedOn(await kept), "b");
  } finally {
    routing.dispose();
  }
});

test("Codex 계정이 여럿이면 구독이 끝났거나 Codex가 이용을 막은 것으로 마지막에 본 기존 계정으로는 바로 재개하지 않고 새 판독을 기다린다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
  ]);
  try {
    for (const [index, access] of [
      { plan: "free" },
      { allowed: false },
    ].entries()) {
      const agentId = `s-${index}`;
      const first = routing.open(agentId, "create");
      await routing.answer("a", 10);
      await routing.answer("b", 50);
      assert.equal(openedOn(await first), "a");

      // Past the ten-minute hold another open finds a's subscription over, or its use refused.
      routing.advance(11 * 60_000);
      const other = routing.open("other", "create");
      await routing.answer("a", 10, access);
      await routing.answer("b", 50);
      assert.equal(openedOn(await other), "b");

      // Three minutes on, the resume of the session bound to a waits for new readings.
      routing.advance(3 * 60_000);
      const resumed = routing.open(agentId, "resume");
      assert.equal(await answersAtOnce(resumed), false, JSON.stringify(access));
      await routing.answer("a", 10, access);
      await routing.answer("b", 50);
      assert.equal(openedOn(await resumed), "b");
      routing.advance(11 * 60_000);
    }
  } finally {
    routing.dispose();
  }
});

test("Codex 계정이 여럿이면 조회에 실패한 기존 계정으로 재개하지 않고 새 판독을 기다려 다른 계정으로 옮긴다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
  ]);
  try {
    const first = routing.open("s", "create");
    await routing.answer("a", 10);
    await routing.answer("b", 50);
    assert.equal(openedOn(await first), "a");

    // A minute later another open renews both readings behind it, and a's lookup fails.
    routing.advance(61_000);
    await routing.open("other", "create");
    await routing.fail("a");
    await routing.answer("b", 50);
    assert.ok(
      routing.logs.includes(
        "[aster] Codex 계정 codex: 구독·한도를 확인할 수 없어 자동 선택에서 제외",
      ),
    );

    // The resume of the session bound to a looks a up again instead of going back to it.
    const resumed = routing.open("s", "resume");
    assert.equal(await answersAtOnce(resumed), false);
    await routing.fail("a");
    assert.equal(openedOn(await resumed), "b");
    assert.match(
      routing.logs.at(-1)!,
      /s \d+ms \(resume · 판독 대기 · codex-second\)$/,
    );
  } finally {
    routing.dispose();
  }
});

test("Codex 턴이 로그인 오류로 끝나 옮기지 못한 세션은 차단이 풀린 뒤에도 그 계정을 다시 확인하고 재개한다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
  ]);
  try {
    const first = routing.open("s", "create");
    await routing.answer("a", 10);
    await routing.answer("b", 50);
    assert.equal(openedOn(await first), "a");

    // The turn fails on a's login; b is chosen, but a new turn holds the session.
    let reloads = 0;
    routing.onReload(async () => void reloads++);
    routing.reportStatus("running");
    await routing.turn("s", {
      kind: "failed",
      error: { message: "unexpected status 401 Unauthorized: token expired" },
    });
    assert.equal(reloads, 0);

    // Past a's one-minute block its dropped reading is not room: the resume asks again.
    routing.advance(61_000);
    const resumed = routing.open("s", "resume");
    assert.equal(await answersAtOnce(resumed), false);
    await routing.fail("a");
    await routing.answer("b", 50);
    assert.equal(openedOn(await resumed), "b");
  } finally {
    routing.dispose();
  }
});

test("Codex 계정 중 하나라도 판독이 없으면 새로고침은 기존 계정으로 바로 열지 않고 전체를 다시 골라 분배한다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
    { id: "codex-third", home: "/c", identity: "c" },
  ]);
  try {
    const first = routing.open("s", "create");
    await routing.answer("a", 50);
    await routing.answer("b", 10);
    await routing.fail("c");
    assert.equal(openedOn(await first), "b");

    // Past the ten-minute hold a has far more room; c still has no reading.
    routing.advance(11 * 60_000);
    const refreshed = routing.open("s", "refresh");
    assert.equal(await answersAtOnce(refreshed), false);
    await routing.answer("a", 10);
    await routing.answer("b", 60);
    await routing.fail("c");
    assert.equal(openedOn(await refreshed), "a");
  } finally {
    routing.dispose();
  }
});

test("Codex 턴 종료 뒤 Aster가 옮기려고 시작한 reload는 판독이 오래됐어도 원래 계정으로 되돌아가지 않는다", async () => {
  const routing = codexRouting([
    { id: "codex", home: "/a", identity: "a" },
    { id: "codex-second", home: "/b", identity: "b" },
  ]);
  try {
    const first = routing.open("s", "create");
    await routing.answer("a", 50);
    await routing.answer("b", 10);
    assert.equal(openedOn(await first), "b");

    // The turn end finds a better; the host opens the session again some minutes later.
    routing.advance(11 * 60_000);
    let reopened: ReturnType<typeof routing.open> | undefined;
    routing.onReload(async (agentId) => {
      routing.advance(150_000);
      reopened = routing.open(agentId, "refresh");
      await reopened;
    });
    const ended = routing.turn("s", { kind: "completed" });
    await routing.answer("a", 10);
    await routing.answer("b", 60);
    await routing.answer("a", 10);
    await routing.answer("b", 60);
    await ended;
    assert.equal(openedOn(await reopened!), "a");
    assert.match(
      routing.logs.at(-1)!,
      /s \d+ms \(refresh · 판독 대기 · codex\)$/,
    );
  } finally {
    routing.dispose();
  }
});

test("이전 배치 실행기는 어떤 프로바이더 명령도 가리키지 않을 때만 지운다", async () =>
  fixture(async (home) => {
    const old = join(home, "aster", "codex-node.cmd");
    await mkdir(join(home, "aster"), { recursive: true });
    await writeFile(old, "@echo off\r\n");
    await writeFile(join(home, "aster", "codex-node.ps1"), "# current");
    const current = [
      "powershell.exe",
      "-File",
      join(home, "aster", "codex-node.ps1"),
      "codex-proxy.mjs",
      '["codex"]',
    ];
    // A provider the bridge could not patch (disabled) still starts Codex through it.
    assert.equal(
      await removeOldLauncher(home, [current, [old, "codex-proxy.mjs"]]),
      false,
    );
    assert.ok(existsSync(old));
    assert.equal(await removeOldLauncher(home, [current, ["claude"]]), true);
    assert.equal(existsSync(old), false);
    assert.ok(existsSync(join(home, "aster", "codex-node.ps1")));
    assert.equal(await removeOldLauncher(home, [current]), false);
  }));
