import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnProcess } from "@getpaseo/plugin/server";
import {
  chooseCodexAccount,
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
  discoverCodexAccounts,
  resumableCodexAccount,
  retryingBridge,
} from "./codex";

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
          resolve("plugins/aster/server/codex-proxy.mjs"),
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
        resolve("plugins/aster/server/codex-proxy.mjs"),
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
        resolve("plugins/aster/server/codex-proxy.mjs"),
        JSON.stringify([process.execPath, script]),
      ]),
      [process.execPath, script],
    );
  }));
