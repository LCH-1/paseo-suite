import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("Aster 설정 화면은 전역 React 없이 동작하도록 JSX를 변환한다", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["plugins/aster/client/accounts.tsx"],
    bundle: false,
    write: false,
    format: "esm",
  });
  const output = result.outputFiles[0].text;
  assert.match(output, /react\/jsx-runtime/);
  assert.doesNotMatch(output, /React\.(?:createElement|Fragment)/);
});
