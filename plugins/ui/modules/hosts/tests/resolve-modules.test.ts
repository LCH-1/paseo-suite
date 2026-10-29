import assert from "node:assert/strict";
import test from "node:test";
import { parseModuleMap, resolveModuleMap } from "../client/resolve-modules";

const source = [
  "__d(function(g,r,i,a,m,e,d){e.getHostRuntimeStore=function(){}},910,[]);",
  ' __d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"orderHostsLocalFirst",{get:function(){}})},920,[]);',
  "__d(function(g,r,i,a,m,e,d){e.getDesktopDaemonStatus=function(){}},930,[]);",
].join("\n");

test("a new app bundle resolves its own module IDs without extending a static compatibility list", async () => {
  const url = "paseo://app/_expo/static/js/web/index-a1234.js?cache=2";
  const read: string[] = [];
  const map = await resolveModuleMap(
    ["paseo://app/unrelated.js", url],
    async (value) => {
      read.push(value);
      return source;
    },
    [],
  );
  assert.deepEqual(map, { bundle: "index-a1234.js", runtime: 910, ordering: 920, desktop: 930 });
  assert.deepEqual(read, [url]);
});

test("known builds keep their reviewed IDs and do not read the app bundle", async () => {
  const known = { bundle: "index-a1234.js", runtime: 10, ordering: 20, desktop: 30 };
  const map = await resolveModuleMap(
    ["paseo://app/index-a1234.js"],
    () => {
      throw new Error("Known build must not fetch");
    },
    [known],
  );
  assert.equal(map, known);
});

test("missing app scripts stay unsupported and failed reads are surfaced", async () => {
  assert.equal(await resolveModuleMap([], async () => source, []), undefined);
  await assert.rejects(
    resolveModuleMap(
      ["paseo://app/index-a1234.js"],
      async () => {
        throw new Error("read failed");
      },
      [],
    ),
    /read failed/,
  );
});

test("ambiguous or incomplete exports never guess another module's ID", () => {
  assert.throws(() => parseModuleMap("index-a1234.js", source + "\n" + source), /확인/);
  assert.throws(
    () => parseModuleMap("index-a1234.js", source.replace("getHostRuntimeStore", "missing")),
    /확인/,
  );
  assert.throws(() => parseModuleMap("index-a1234.js", source.replace("},910,[]);", "};")), /ID/);
});
