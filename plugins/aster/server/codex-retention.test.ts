import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  codexRollouts,
  pruneCodexHistory,
  retentionSummary,
  rolloutParent,
} from "./codex-retention";
import { codexHomeOf, deleteCodexThreads } from "./codex";
import { settingsSchema } from "./accounts";

const DAY = 86_400_000;
const now = 1_800_000_000_000;
const thread = (n: number) =>
  `01980000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A rollout as Codex 0.167 writes it: `session_meta` first, a sub-agent naming its parent. */
const meta = (id: string, parent?: string) =>
  [
    JSON.stringify({
      timestamp: "2026-08-01T00:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        id,
        source: parent
          ? {
              subagent: {
                thread_spawn: { parent_thread_id: parent, depth: 1 },
              },
            }
          : "cli",
      },
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }),
    "",
  ].join("\n");

/** Text is compressed for a `.zst` path; bytes are written as they are. */
async function rollout(
  home: string,
  relative: string,
  id: string,
  ageDays: number,
  content: string | Buffer = meta(id),
) {
  const file = join(home, relative.replace("{id}", id));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof content === "string" && file.endsWith(".zst")
      ? zstdCompressSync(Buffer.from(content))
      : content,
  );
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
    );
    const archived = await rollout(
      codexHome,
      "archived_sessions/rollout-2026-08-02T01-02-03-{id}.jsonl.zst",
      thread(2),
      95,
    );
    const bytes = (await stat(old)).size + (await stat(archived)).size;
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
      bytes,
      skipped: 1,
      kept: 1,
      children: 0,
      parents: 0,
      unreadable: 0,
      reason: `thread ${thread(6)} already has an active writer`,
    });
    for (const file of [recent, open, resumedOld, busy, other])
      assert.ok(existsSync(file), file);
    assert.equal(
      retentionSummary(90, result),
      `[aster] Codex 대화 기록 보존 90일: 2개 대화 0.0MB 삭제, 1개 건너뜀(사용 중·삭제 거부: thread ${thread(6)} already has an active writer), Paseo 열린 대화 1개 보존`,
    );
  }));

test("Codex 대화 기록 보존은 남는 대화가 띄운 하위 작업 대화를 오래돼도 남기고 Paseo가 여는 native handle 도 보호한다", async () =>
  workspace(async (root) => {
    const codexHome = join(root, "codex"),
      paseoHome = join(root, "paseo");
    const file = (n: number, parent?: number, zst = false) =>
      rollout(
        codexHome,
        `sessions/2026/08/01/rollout-2026-08-01T01-02-03-{id}.jsonl${zst ? ".zst" : ""}`,
        thread(n),
        n === 3 ? 1 : 100,
        zst
          ? zstdCompressSync(
              Buffer.from(
                meta(
                  thread(n),
                  parent === undefined ? undefined : thread(parent),
                ),
              ),
            )
          : meta(thread(n), parent === undefined ? undefined : thread(parent)),
      );
    // 1 is open in Paseo; 2 is its sub-agent and 7 one that 2 spawned, compressed.
    await file(1);
    const child = await file(2, 1);
    const grandchild = await file(7, 2, true);
    // 3 is recent (a Codex app conversation): its old sub-agent 4 stays with it.
    await file(3);
    const recentChild = await file(4, 3);
    // 5 goes, and its sub-agent 6 is handed over with it; 8's parent is long gone.
    await file(5);
    await file(6, 5, true);
    await file(8, 99);
    // 9 and 10 are open in Paseo under the handle Paseo resumes them by.
    await file(9);
    await file(10);
    await mkdir(join(paseoHome, "agents", "project"), { recursive: true });
    await writeFile(
      join(paseoHome, "agents", "project", "open.json"),
      JSON.stringify({ id: "a", persistence: { sessionId: thread(1) } }),
    );
    await writeFile(
      join(paseoHome, "agents", "project", "handle.json"),
      JSON.stringify({
        id: "b",
        persistence: { sessionId: "renamed", nativeHandle: thread(9) },
      }),
    );
    await writeFile(
      join(paseoHome, "agents", "project", "metadata.json"),
      JSON.stringify({
        id: "c",
        persistence: {
          sessionId: "renamed",
          metadata: { threadId: thread(10) },
        },
      }),
    );

    assert.equal(
      await rolloutParent([{ path: grandchild, size: 0, modified: 0 }]),
      thread(2),
    );
    const asked: string[][] = [];
    const result = await pruneCodexHistory({
      codexHome,
      paseoHome,
      days: 90,
      now,
      remove: async (threadIds) => {
        asked.push([...threadIds].sort());
        return {};
      },
    });
    assert.deepEqual(asked, [[thread(5), thread(6), thread(8)]]);
    assert.equal(result.kept, 3);
    assert.equal(result.children, 3);
    for (const kept of [child, grandchild, recentChild])
      assert.ok(existsSync(kept), kept);
    assert.match(
      retentionSummary(90, result),
      /, Paseo 열린 대화 3개 보존, 남는 대화의 하위 작업 3개 보존$/,
    );
  }));

test("Codex 대화 기록 보존은 기간 안이거나 Paseo에서 열린 하위 작업 대화를 띄운 대화를 첫 대화까지 남겨 함께 지워지지 않게 한다", async () =>
  workspace(async (root) => {
    const codexHome = join(root, "codex"),
      paseoHome = join(root, "paseo");
    const file = (n: number, ageDays: number, parent?: number, zst = false) => {
      const body = meta(
        thread(n),
        parent === undefined ? undefined : thread(parent),
      );
      return rollout(
        codexHome,
        `sessions/2026/08/01/rollout-2026-08-01T01-02-03-{id}.jsonl${zst ? ".zst" : ""}`,
        thread(n),
        ageDays,
        zst ? zstdCompressSync(Buffer.from(body)) : body,
      );
    };
    // 12 was spawned by 11 and continued on its own within the period.
    const parent = await file(11, 120);
    await file(12, 1, 11);
    // 14, spawned by 13, is open in Paseo.
    const openParent = await file(13, 120);
    await file(14, 120, 13);
    await mkdir(join(paseoHome, "agents", "project"), { recursive: true });
    await writeFile(
      join(paseoHome, "agents", "project", "open.json"),
      JSON.stringify({ id: "a", persistence: { sessionId: thread(14) } }),
    );
    // 17 is recent, spawned by 16, spawned by 15; 18 is 16's other old sub-agent.
    const first = await file(15, 120);
    const middle = await file(16, 120, 15, true);
    const sibling = await file(18, 120, 16);
    await file(17, 1, 16);
    // 19 and its sub-agent 20 have nothing recent or open below them.
    await file(19, 120);
    await file(20, 120, 19);

    const asked: string[][] = [];
    const result = await pruneCodexHistory({
      codexHome,
      paseoHome,
      days: 90,
      now,
      remove: async (threadIds) => {
        asked.push([...threadIds].sort());
        return {};
      },
    });
    assert.deepEqual(asked, [[thread(19), thread(20)]]);
    assert.equal(result.kept, 1);
    assert.equal(result.children, 1);
    assert.equal(result.parents, 4);
    for (const kept of [parent, openParent, first, middle, sibling])
      assert.ok(existsSync(kept), kept);
    assert.match(
      retentionSummary(90, result),
      /: 0개 대화 0\.0MB 삭제, 2개 건너뜀\(사용 중·삭제 거부\), Paseo 열린 대화 1개 보존, 남는 대화의 하위 작업 1개 보존, 남는 하위 작업을 띄운 대화 4개 보존$/,
    );
  }));

/** First lines that tell nothing about the thread that spawned it. */
const unreadableFirstLines: Array<[string, string | Buffer]> = [
  ["깨진 줄", '{"timestamp":"2026-11-13T00:00:00.000Z","type":"sess'],
  ["1MB 넘는 줄", "x".repeat(1_100_000)],
  ["빈 파일", ""],
  [
    "session_meta 가 아닌 줄",
    `${JSON.stringify({ type: "response_item", payload: {} })}\n`,
  ],
];

test("남는 대화의 rollout 첫 줄을 읽지 못하면 그 대화를 띄운 대화를 알 수 없어 그날 정리를 보류한다", async () => {
  const cases: Array<
    [string, (codexHome: string, paseoHome: string) => Promise<void>]
  > = [
    ...unreadableFirstLines.map(([name, body]): (typeof cases)[number] => [
      `기간 안 하위 작업 · ${name}`,
      async (codexHome) => {
        await rollout(
          codexHome,
          "sessions/2026/11/13/rollout-2026-11-13T01-02-03-{id}.jsonl",
          thread(22),
          1,
          body,
        );
      },
    ]),
    [
      "기간 안 하위 작업 · 풀 수 없는 zst",
      async (codexHome) => {
        await rollout(
          codexHome,
          "sessions/2026/11/13/rollout-2026-11-13T01-02-03-{id}.jsonl.zst",
          thread(22),
          1,
          Buffer.from("not zstd"),
        );
      },
    ],
    [
      "Paseo 에서 열린 오래된 하위 작업 · 깨진 줄",
      async (codexHome, paseoHome) => {
        await rollout(
          codexHome,
          "sessions/2026/07/01/rollout-2026-07-01T01-02-03-{id}.jsonl",
          thread(22),
          120,
          "{ torn",
        );
        await mkdir(join(paseoHome, "agents", "project"), { recursive: true });
        await writeFile(
          join(paseoHome, "agents", "project", "open.json"),
          JSON.stringify({ id: "a", persistence: { sessionId: thread(22) } }),
        );
      },
    ],
    [
      "기간 안 하위 작업이 띄운 대화로 남는 오래된 대화 · 깨진 줄",
      async (codexHome) => {
        await rollout(
          codexHome,
          "sessions/2026/07/01/rollout-2026-07-01T01-02-03-{id}.jsonl",
          thread(24),
          120,
          "{ torn",
        );
        await rollout(
          codexHome,
          "sessions/2026/11/13/rollout-2026-11-13T01-02-03-{id}.jsonl",
          thread(25),
          1,
          meta(thread(25), thread(24)),
        );
      },
    ],
  ];
  for (const [name, arrange] of cases)
    await workspace(async (root) => {
      const codexHome = join(root, "codex"),
        paseoHome = join(root, "paseo");
      // 21 may be the thread that spawned the unreadable one; 23 is plainly old.
      const files = [
        await rollout(
          codexHome,
          "sessions/2026/07/01/rollout-2026-07-01T01-02-03-{id}.jsonl",
          thread(21),
          120,
        ),
        await rollout(
          codexHome,
          "sessions/2026/07/02/rollout-2026-07-02T01-02-03-{id}.jsonl",
          thread(23),
          120,
        ),
      ];
      await arrange(codexHome, paseoHome);
      let calls = 0;
      await assert.rejects(
        pruneCodexHistory({
          codexHome,
          paseoHome,
          days: 90,
          now,
          remove: async () => {
            calls++;
            return {};
          },
        }),
        /남는 대화 1개의 rollout 첫 줄을 읽지 못해/,
        name,
      );
      assert.equal(calls, 0, name);
      for (const file of files) assert.ok(existsSync(file), name);
    });
});

test("첫 줄을 읽지 못한 오래된 대화는 남는 대화의 하위 작업일 수 있어 그것이 띄운 대화와 함께 남기고 나머지는 정리한다", async () => {
  for (const [name, body] of unreadableFirstLines)
    await workspace(async (root) => {
      const codexHome = join(root, "codex"),
        paseoHome = join(root, "paseo");
      const unknown = await rollout(
        codexHome,
        "sessions/2026/07/01/rollout-2026-07-01T01-02-03-{id}.jsonl",
        thread(41),
        120,
        body,
      );
      const spawned = await rollout(
        codexHome,
        "sessions/2026/07/01/rollout-2026-07-01T02-02-03-{id}.jsonl",
        thread(42),
        120,
        meta(thread(42), thread(41)),
      );
      await rollout(
        codexHome,
        "sessions/2026/07/02/rollout-2026-07-02T01-02-03-{id}.jsonl",
        thread(43),
        120,
      );
      // One readable first line among a thread's rollouts is enough to know it.
      await rollout(
        codexHome,
        "archived_sessions/rollout-2026-07-03T01-02-03-{id}.jsonl",
        thread(45),
        120,
        body,
      );
      await rollout(
        codexHome,
        "sessions/2026/07/03/rollout-2026-07-03T01-02-03-{id}.jsonl",
        thread(45),
        110,
      );
      assert.equal(
        await rolloutParent([{ path: unknown, size: 0, modified: 0 }]),
        undefined,
        name,
      );
      const asked: string[][] = [];
      const result = await pruneCodexHistory({
        codexHome,
        paseoHome,
        days: 90,
        now,
        remove: async (threadIds) => {
          asked.push([...threadIds].sort());
          return {};
        },
      });
      assert.deepEqual(asked, [[thread(43), thread(45)]], name);
      assert.equal(result.unreadable, 1, name);
      assert.equal(result.children, 1, name);
      for (const file of [unknown, spawned]) assert.ok(existsSync(file), name);
      assert.match(
        retentionSummary(90, result),
        /, 남는 대화의 하위 작업 1개 보존, 첫 줄을 읽지 못한 오래된 대화 1개 보존$/,
        name,
      );
    });
});

test("zstd 를 풀 수 없는 Node 에서는 압축된 rollout 이 있으면 그날 정리를 보류한다", async () =>
  workspace(async (root) => {
    const codexHome = join(root, "codex"),
      paseoHome = join(root, "paseo");
    // 32, compressed and recent, was spawned by the old 31; 33 is plainly old.
    const parent = await rollout(
      codexHome,
      "sessions/2026/07/01/rollout-2026-07-01T01-02-03-{id}.jsonl",
      thread(31),
      120,
    );
    await rollout(
      codexHome,
      "sessions/2026/11/13/rollout-2026-11-13T01-02-03-{id}.jsonl.zst",
      thread(32),
      1,
      meta(thread(32), thread(31)),
    );
    const plain = await rollout(
      codexHome,
      "sessions/2026/07/02/rollout-2026-07-02T01-02-03-{id}.jsonl",
      thread(33),
      120,
    );
    const asked: string[][] = [];
    const run = (zstd?: boolean) =>
      pruneCodexHistory({
        codexHome,
        paseoHome,
        days: 90,
        now,
        remove: async (threadIds) => {
          asked.push([...threadIds].sort());
          return {};
        },
        ...(zstd === undefined ? {} : { zstd }),
      });
    await assert.rejects(
      run(false),
      /zstd 를 풀지 못해 압축된 rollout 대화 1개/,
    );
    assert.deepEqual(asked, []);
    for (const file of [parent, plain]) assert.ok(existsSync(file), file);
    // Where it can, the compressed sub-agent keeps the thread that spawned it.
    assert.equal((await run()).parents, 1);
    assert.deepEqual(asked, [[thread(33)]]);
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
    const nothing = {
      removed: 0,
      bytes: 0,
      skipped: 0,
      kept: 0,
      children: 0,
      parents: 0,
      unreadable: 0,
    };
    assert.deepEqual(
      await pruneCodexHistory({ codexHome, paseoHome, days: 90, now, remove }),
      nothing,
    );
    assert.equal(
      retentionSummary(90, nothing),
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
