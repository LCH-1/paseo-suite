import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("building a new app map preserves earlier bundles", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-host-order-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "scripts/build.mjs");
  const mapsPath = path.join(directory, "client/module-maps.ts");
  const app = path.join(directory, "app");
  const bundle = "index-a1b2c3d4.js";
  const bundlePath = path.join(app, "_expo/static/js/web", bundle);
  const previous = [
    { bundle: "index-aabbccdd.js", runtime: 1, ordering: 2, desktop: 3 },
    { bundle: "index-eeff0011.js", runtime: 4, ordering: 5, desktop: 6 },
  ];
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(path.dirname(mapsPath), { recursive: true });
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(script, await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8"));
  await writeFile(mapsPath, `export default ${JSON.stringify(previous)};\n`);
  await writeFile(path.join(app, "index.html"), `<script src="/_expo/static/js/web/${bundle}"></script>`);
  await writeFile(bundlePath, [
    "__d(function(g,r,i,a,m,e,d){e.getHostRuntimeStore=function(){}},10,[]);",
    "__d(function(g,r,i,a,m,e,d){e.orderHostsLocalFirst=function(){}},11,[]);",
    "__d(function(g,r,i,a,m,e,d){e.getDesktopDaemonStatus=function(){}},12,[]);",
  ].join("\n"));

  await execute(process.execPath, [script, app], { windowsHide: true });

  const generated = await readFile(mapsPath, "utf8");
  const maps = JSON.parse(generated.replace(/^export default\s+/, "").replace(/;\s*$/, ""));
  assert.deepEqual(maps, [...previous, { bundle, runtime: 10, ordering: 11, desktop: 12 }]);
});
