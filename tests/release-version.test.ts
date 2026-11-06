import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

test("릴리스 버전은 패키지·잠금 파일·빌드 기록·설치 파일 이름에서 모두 같다", async () => {
  const { version } = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);

  const build = await read("tools/build.mjs");
  assert.equal(build.match(/suiteVersion: "([^"]+)"/)?.[1], version);

  // The updater compares this value, so a stale one hides the release from installed apps.
  const builder = await read("tools/electron-builder.cjs");
  assert.equal(builder.match(/extraMetadata: \{ version: "([^"]+)" \}/)?.[1], version);
  const names = [...builder.matchAll(/Paseo-Suite-([\d.]+)-\$\{arch\}/g)].map((match) => match[1]);
  assert.ok(names.length > 0);
  assert.deepEqual([...new Set(names)], [version]);
});
