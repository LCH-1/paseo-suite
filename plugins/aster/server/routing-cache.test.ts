import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoutingCache } from "./routing-cache.ts";
import type { Account } from "./accounts.ts";

const a: Account = { id: "a", home: "/synthetic/account-a", email: "a@synthetic.invalid", identity: "org-a|a@synthetic.invalid" };
const b: Account = { id: "b", home: "/synthetic/account-b", email: "b@synthetic.invalid", identity: "org-b|b@synthetic.invalid" };
const recordName = (id: string) => createHash("sha256").update(id).digest("hex") + ".json";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "paseo-aster-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "routing-cache");
  const warnings: string[] = [];
  return { root, directory, warnings, cache: new RoutingCache(directory, warning => { warnings.push(warning); }) };
}

test("플러그인 새 인스턴스가 원래 계정과 유지 시간을 복구하고 개인 정보는 저장하지 않는다", async t => {
  const f = await fixture(t);
  assert.equal(await f.cache.save("session", b, { accountId: "b", switchedAt: 100 }), true);
  assert.deepEqual(await new RoutingCache(f.directory).load("session", [a, b], 200), { kind: "managed", binding: { accountId: "b", switchedAt: 100 } });
  const raw = await readFile(join(f.directory, recordName("session")), "utf8");
  for (const value of [b.email!, b.identity!, b.home, "accessToken", "refreshToken"]) assert.equal(raw.includes(value), false);
});

test("계정 ID가 재사용돼도 다른 계정에 연결하지 않고 같은 계정의 ID 변경은 따른다", async t => {
  const f = await fixture(t);
  await f.cache.save("session", b, { accountId: "b", switchedAt: 100 });
  assert.equal(await f.cache.load("session", [{ ...a, id: "b" }], 200), null);
  assert.deepEqual(await f.cache.load("session", [a, { ...b, id: "renamed-b" }], 200), { kind: "managed", binding: { accountId: "renamed-b", switchedAt: 100 } });
  assert.equal(await f.cache.load("session", [b], 99), null);
});

test("여러 세션과 같은 세션의 연속 갱신을 잃지 않고 기록한다", async t => {
  const f = await fixture(t);
  await Promise.all([
    f.cache.save("first", a, { accountId: "a", switchedAt: 100 }),
    f.cache.save("second", b, { accountId: "b", switchedAt: 100 }),
    f.cache.save("first", b, { accountId: "b", switchedAt: 101 }),
  ]);
  assert.deepEqual(await f.cache.load("first", [a, b], 200), { kind: "managed", binding: { accountId: "b", switchedAt: 101 } });
  assert.deepEqual(await f.cache.load("second", [a, b], 200), { kind: "managed", binding: { accountId: "b", switchedAt: 100 } });
});

test("원자적 교체 실패 시 이전 연결을 보존하고 임시 파일을 읽지 않는다", async t => {
  const f = await fixture(t);
  await f.cache.save("session", a, { accountId: "a", switchedAt: 100 });
  const failing = new RoutingCache(f.directory, warning => { f.warnings.push(warning); }, async () => { throw new Error("synthetic rename failure"); });
  assert.equal(await failing.save("session", b, { accountId: "b", switchedAt: 101 }), false);
  assert.deepEqual(await f.cache.load("session", [a, b], 200), { kind: "managed", binding: { accountId: "a", switchedAt: 100 } });
  assert.deepEqual(await readdir(f.directory), [recordName("session")]);
  assert.equal(f.warnings.length, 1);
});

test("깨지거나 큰 캐시는 실행을 차단하지 않고 다음 정상 기록으로 복구한다", async t => {
  const f = await fixture(t);
  await mkdir(f.directory);
  for (const raw of ["{", "x".repeat(5000), JSON.stringify({ version: 999, kind: "managed", accessToken: "synthetic-secret" })]) {
    await writeFile(join(f.directory, recordName("session")), raw);
    assert.equal(await f.cache.load("session", [a, b]), null);
    assert.equal(await f.cache.save("session", b, { accountId: "b", switchedAt: 100 }), true);
    assert.deepEqual(await f.cache.load("session", [b], 200), { kind: "managed", binding: { accountId: "b", switchedAt: 100 } });
  }
  assert.equal(f.warnings.some(warning => warning.includes("synthetic-secret")), false);
});

test("명시적 자동 관리 제외도 재로드 이후 유지하고 재관리 기록으로 교체한다", async t => {
  const f = await fixture(t);
  await f.cache.exclude("session");
  assert.deepEqual(await new RoutingCache(f.directory).load("session", []), { kind: "excluded" });
  await f.cache.save("session", a, { accountId: "a", switchedAt: 100 });
  assert.deepEqual(await f.cache.load("session", [a], 200), { kind: "managed", binding: { accountId: "a", switchedAt: 100 } });
  await f.cache.forget("session");
  assert.equal(await f.cache.load("session", [a]), null);
});

test("임의 세션 이름을 파일 경로로 쓰지 않는다", async t => {
  const f = await fixture(t);
  await f.cache.save("../../outside", a, { accountId: "a", switchedAt: 100 });
  assert.deepEqual(await readdir(f.directory), [recordName("../../outside")]);
});

test("캐시 디렉터리가 외부 경로를 가리키면 쓰기를 거부한다", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, f.directory, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await f.cache.save("session", a, { accountId: "a", switchedAt: 100 }), false);
  assert.deepEqual(await readdir(outside), []);
});
