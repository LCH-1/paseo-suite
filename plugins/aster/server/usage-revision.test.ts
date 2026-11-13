import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageRevision } from "./usage-revision";

test("인증 변경 표식의 첫 관측은 기준값으로만 삼고 그 뒤의 변경만 알린다", async () => {
  const home = await mkdtemp(join(tmpdir(), "aster-revision-"));
  try {
    const marker = join(home, "settings-sync", "credential-revision");
    await mkdir(join(home, "settings-sync"));
    await writeFile(marker, "1");
    let changes = 0;
    const check = usageRevision(home, () => changes++);
    assert.equal(await check(), false);
    assert.equal(await check(), false);
    assert.equal(changes, 0);
    await writeFile(marker, "2");
    assert.equal(await check(), true);
    assert.equal(await check(), false);
    await rm(marker);
    assert.equal(await check(), true);
    assert.equal(changes, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
