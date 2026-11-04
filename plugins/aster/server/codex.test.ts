import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { spawnProcess } from "@getpaseo/plugin/server";
import {
  chooseCodexAccount,
  hasCodexSubscription,
  type CodexReading,
} from "./codex-policy";
import { codexTokens, inspectCodexAccount } from "./codex-runtime.mjs";
import {
  codexNodeLauncher,
  codexOriginalCommand,
  discoverCodexAccounts,
} from "./codex";

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
const readline=require('node:readline');let loggedIn=false,refreshRequest;
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='fixture/refresh'){refreshRequest=m.id;process.stdout.write(JSON.stringify({id:'fixture-private-refresh',method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:m.params.account}})+'\\n');return;}
if(m.id==='fixture-private-refresh'){process.stdout.write(JSON.stringify({id:refreshRequest,result:{accepted:!m.error,identity:m.result?.chatgptAccountId}})+'\\n');return;}
if(m.method==='account/login/start'){loggedIn=m.params.type==='chatgptAuthTokens';result={type:'chatgptAuthTokens'};}
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'pro'}};
if(m.method==='account/rateLimits/read')result={accountId:'account-a',rateLimits:{planType:'pro',primary:{usedPercent:23,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}},ordinaryUsageAllowed:true};
if(m.method==='thread/resume')result={thread:m.params.threadId,home:process.env.CODEX_HOME,loggedIn,ephemeral:process.argv.includes('cli_auth_credentials_store="ephemeral"')};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`;

test("Electron 실행 launcher는 환경변수를 직접 설정하고 경로를 이스케이프한다", () => {
  assert.equal(
    codexNodeLauncher("C:\\앱 100%\\Paseo.exe", "win32").content,
    '@echo off\r\nchcp 65001 >nul\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\앱 100%%\\Paseo.exe" %*\r\nexit /b %errorlevel%\r\n',
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
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawnProcess(file, [script, original, "app-server"], {
        stdio: "pipe",
        env,
      });
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stdin.write("ping\n");
      const code = await new Promise((accept) => child.on("close", accept));
      assert.equal(code, 7);
      assert.deepEqual(JSON.parse(output), {
        args: [original, "app-server"],
        env: "1",
        input: "ping",
      });
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
