import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const jwt = (exp) =>
  `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const fake = `
const fs=require("node:fs"),path=require("node:path"),readline=require("node:readline");
let access;
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==="account/read"){
  const file=path.join(process.env.CODEX_HOME,"auth.json"),v=JSON.parse(fs.readFileSync(file));
  if(v.tokens.refresh_token==="denied"){process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:"expired"}})+"\\n");return;}
  v.tokens.access_token="header."+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString("base64url")+".signature";
  fs.writeFileSync(file,JSON.stringify(v));result={account:{type:"chatgpt"}};
 }
 if(m.method==="account/login/start")access=m.params.accessToken;
 if(m.method==="turn/start")result={valid:JSON.parse(Buffer.from(access.split(".")[1],"base64url")).exp>Date.now()/1000,matchesStored:access===JSON.parse(fs.readFileSync(path.join(process.env.ASTER_CODEX_ACCOUNT_HOME,"auth.json"))).tokens.access_token,threadId:m.params.threadId};
 process.stdout.write(JSON.stringify({id:m.id,result})+"\\n");
});`;

async function scenario(initiallyExpired, rejectRefresh, run) {
  const home = await mkdtemp(join(tmpdir(), "aster-token-turn-"));
  const account = join(home, "account");
  await mkdir(account);
  const file = join(account, "auth.json");
  const save = (expired) =>
    writeFile(
      file,
      JSON.stringify({
        tokens: {
          account_id: "same-account",
          refresh_token: rejectRefresh ? "denied" : "refresh",
          access_token: jwt(
            Math.floor(Date.now() / 1000) + (expired ? -10 : 3600),
          ),
        },
      }),
    );
  await save(initiallyExpired);
  const fixture = join(home, "fixture.cjs");
  await writeFile(fixture, fake);
  const child = spawn(
    process.execPath,
    [
      resolve("plugins/aster/server/codex-proxy.mjs"),
      JSON.stringify([process.execPath, fixture]),
      "app-server",
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: home,
        ASTER_CODEX_ACCOUNT_HOME: account,
        ASTER_CODEX_ACCOUNT_ID: "same-account",
      },
    },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.resume();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  const request = (id, method, params = {}) =>
    new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(Error("proxy timeout")), 5000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        accept(message);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await request(1, "initialize");
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    await run({ request, save });
    assert.equal(output.includes("header."), false);
    assert.equal(output.includes("aster-login-"), false);
  } finally {
    lines.close();
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
}

test("만료된 시작 토큰은 공식 CLI로 갱신한 뒤 첫 턴에 주입한다", () =>
  scenario(true, false, async ({ request }) => {
    const response = await request(2, "turn/start", {
      threadId: "existing-thread",
    });
    assert.deepEqual(response.result, {
      valid: true,
      matchesStored: true,
      threadId: "existing-thread",
    });
  }));

test("열린 대화도 다음 턴 전에 갱신된 인증을 다시 적용한다", () =>
  scenario(false, false, async ({ request, save }) => {
    assert.equal(
      (await request(2, "turn/start", { threadId: "existing-thread" })).result
        .valid,
      true,
    );
    await save(true);
    assert.deepEqual(
      (await request(3, "turn/start", { threadId: "existing-thread" })).result,
      { valid: true, matchesStored: true, threadId: "existing-thread" },
    );
  }));

test("공식 토큰 갱신이 실패하면 만료된 인증으로 턴을 보내지 않는다", () =>
  scenario(true, true, async ({ request }) => {
    const response = await request(2, "turn/start", {
      threadId: "existing-thread",
    });
    assert.equal(response.result, undefined);
    assert.equal(response.error.code, -32000);
  }));
