import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  codexRollouts,
  pruneCodexHistory,
  retentionSummary,
} from "./codex-retention";
import { codexHomeOf, deleteCodexThreads } from "./codex";
import { settingsSchema } from "./accounts";

const DAY = 86_400_000;
const now = 1_800_000_000_000;
const thread = (n: number) =>
  `01980000-0000-7000-8000-${String(n).padStart(12, "0")}`;

async function rollout(
  home: string,
  relative: string,
  id: string,
  ageDays: number,
  size = 100,
) {
  const file = join(home, relative.replace("{id}", id));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "x".repeat(size));
  const at = (now - ageDays * DAY) / 1000;
  await utimes(file, at, at);
  return file;
}

async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aster-codex-retention-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex 대화 기록 보존은 모든 rollout 이 기간을 넘긴 대화만 공식 삭제에 넘기고 Paseo 열린 대화·사용 중 대화는 남기며 결과를 한 줄로 알린다", async () =>
  workspace(async (root) => {
    const codexHome = join(root, "codex"),
      paseoHome = join(root, "paseo");
    const old = await rollout(
      codexHome,
      "sessions/2026/08/01/rollout-2026-08-01T01-02-03-{id}.jsonl",
      thread(1),
      100,
      300,
    );
    const archived = await rollout(
      codexHome,
      "archived_sessions/rollout-2026-08-02T01-02-03-{id}.jsonl.zst",
      thread(2),
      95,
      200,
    );
    const recent = await rollout(
      codexHome,
      "sessions/2026/11/12/rollout-2026-11-12T01-02-03-{id}.jsonl",
      thread(3),
      1,
    );
    const open = await rollout(
      codexHome,
      "sessions/2026/08/03/rollout-2026-08-03T01-02-03-{id}.jsonl",
      thread(4),
      100,
    );
    // An old file of a thread that was used again later stays with it.
    const resumedOld = await rollout(
      codexHome,
      "archived_sessions/rollout-2026-08-04T01-02-03-{id}.jsonl",
      thread(5),
      100,
    );
    await rollout(
      codexHome,
      "sessions/2026/11/10/rollout-2026-08-04T01-02-03-{id}.jsonl",
      thread(5),
      3,
    );
    const busy = await rollout(
      codexHome,
      "sessions/2026/08/05/rollout-2026-08-05T01-02-03-{id}.jsonl",
      thread(6),
      100,
    );
    const other = join(codexHome, "sessions", "2026", "08", "01", "notes.txt");
    await writeFile(other, "not a rollout");
    await utimes(other, (now - 200 * DAY) / 1000, (now - 200 * DAY) / 1000);
    await mkdir(join(paseoHome, "agents", "project"), { recursive: true });
    await writeFile(
      join(paseoHome, "agents", "project", "open.json"),
      JSON.stringify({ id: "a", persistence: { sessionId: thread(4) } }),
    );
    await writeFile(
      join(paseoHome, "agents", "archived.json"),
      JSON.stringify({
        id: "b",
        archivedAt: "2026-09-01T00:00:00.000Z",
        persistence: { sessionId: thread(1) },
      }),
    );

    const asked: string[][] = [];
    const result = await pruneCodexHistory({
      codexHome,
      paseoHome,
      days: 90,
      now,
      remove: async (threadIds) => {
        asked.push([...threadIds].sort());
        for (const file of [old, archived]) await rm(file);
        return { reason: `thread ${thread(6)} already has an active writer` };
      },
    });
    assert.deepEqual(asked, [[thread(1), thread(2), thread(6)]]);
    assert.deepEqual(result, {
      removed: 2,
      bytes: 500,
      skipped: 1,
      kept: 1,
      reason: `thread ${thread(6)} already has an active writer`,
    });
    for (const file of [recent, open, resumedOld, busy, other])
      assert.ok(existsSync(file), file);
    assert.equal(
      retentionSummary(90, result),
      `[aster] Codex 대화 기록 보존 90일: 2개 대화 0.0MB 삭제, 1개 건너뜀(사용 중·삭제 거부: thread ${thread(6)} already has an active writer), Paseo 열린 대화 1개 보존`,
    );
  }));

test("지울 대화가 없으면 Codex를 띄우지 않고 Paseo 기록을 읽을 수 없으면 아무것도 지우지 않는다", async () =>
  workspace(async (root) => {
    const codexHome = join(root, "codex"),
      paseoHome = join(root, "paseo");
    await rollout(
      codexHome,
      "sessions/2026/11/12/rollout-2026-11-12T01-02-03-{id}.jsonl",
      thread(1),
      10,
    );
    let calls = 0;
    const remove = async () => {
      calls++;
      return {};
    };
    assert.deepEqual(
      await pruneCodexHistory({ codexHome, paseoHome, days: 90, now, remove }),
      { removed: 0, bytes: 0, skipped: 0, kept: 0 },
    );
    assert.equal(
      retentionSummary(90, { removed: 0, bytes: 0, skipped: 0, kept: 0 }),
      "[aster] Codex 대화 기록 보존 90일: 0개 대화 0.0MB 삭제",
    );
    await rollout(
      codexHome,
      "sessions/2026/08/01/rollout-2026-08-01T01-02-03-{id}.jsonl",
      thread(2),
      100,
    );
    await mkdir(join(paseoHome, "agents"), { recursive: true });
    await writeFile(join(paseoHome, "agents", "torn.json"), "{ half");
    await assert.rejects(
      pruneCodexHistory({ codexHome, paseoHome, days: 90, now, remove }),
    );
    assert.equal(calls, 0);
    assert.equal((await codexRollouts(codexHome)).size, 2);
  }));

const fakeDeleteServer = `
const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='thread/delete'){fs.appendFileSync(path.join(process.env.CODEX_HOME,'deleted.txt'),m.params.threadId+'\\n');
if(m.params.threadId==='busy'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'thread busy already has an active writer'}})+'\\n');return;}}
process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`;

test("공식 app-server thread/delete 로 하나씩 지우고 거절 사유를 남긴다", async () =>
  workspace(async (root) => {
    const script = join(root, "fake.cjs");
    await writeFile(script, fakeDeleteServer);
    const result = await deleteCodexThreads(
      [process.execPath, script],
      root,
      ["first", "busy", "last"],
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      reason: "thread busy already has an active writer",
    });
    assert.equal(
      await readFile(join(root, "deleted.txt"), "utf8"),
      "first\nbusy\nlast\n",
    );
  }));

test("보존 기간 설정은 양의 정수일 때만 켜지고 잘못된 값은 Aster 설정 전체를 깨지 않는다", () => {
  const days = (value: unknown) =>
    settingsSchema.parse({ codexHistoryRetentionDays: value })
      .codexHistoryRetentionDays;
  assert.equal(days(90), 90);
  for (const value of [undefined, 0, -1, 1.5, "90", null])
    assert.equal(days(value), undefined);
  assert.deepEqual(settingsSchema.parse({}).capacities, {});
});

test("Codex 기록 폴더는 기본 provider 의 CODEX_HOME, 없으면 사용자 홈의 .codex", () => {
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    const user = join(tmpdir(), "user");
    assert.equal(codexHomeOf({}, user), join(user, ".codex"));
    assert.equal(
      codexHomeOf({ codex: { env: { CODEX_HOME: "~/codex-home" } } }, user),
      join(user, "codex-home"),
    );
    assert.throws(() =>
      codexHomeOf({ codex: { env: { CODEX_HOME: "relative" } } }, user),
    );
  } finally {
    if (saved !== undefined) process.env.CODEX_HOME = saved;
  }
});
