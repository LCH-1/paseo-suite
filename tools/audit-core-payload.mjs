import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const project = path.resolve(process.argv[2]);
const core = path.resolve(root, "../paseo-core");
const require = createRequire(path.join(core, "package.json"));
const asar = require("@electron/asar");
const session = JSON.parse(
  fs.readFileSync(
    path.join(
      project,
      "sidebar-title-sync/deployment/normal-client-session.json",
    ),
    "utf8",
  ),
);
const resources = path.join(path.dirname(session.program), "resources");
const archive = path.join(resources, "app.asar");
const differences = [];
for (const file of asar.listPackage(archive)) {
  if (!file.endsWith(".js")) continue;
  const relative = file.replace(/^[/\\]/, "").replaceAll("\\", "/");
  let source;
  const server = "node_modules/@getpaseo/server/";
  if (relative.startsWith(server))
    source = path.join(core, "packages/server", relative.slice(server.length));
  else if (relative.startsWith("dist/"))
    source = path.join(core, "packages/desktop", relative);
  else continue;
  if (!fs.existsSync(source)) {
    differences.push({ path: relative, missing: true });
    continue;
  }
  const installed = asar
    .extractFile(archive, path.normalize(relative))
    .toString()
    .replaceAll("\r\n", "\n");
  const built = fs.readFileSync(source, "utf8").replaceAll("\r\n", "\n");
  if (installed !== built)
    differences.push({
      path: relative,
      installedBytes: installed.length,
      builtBytes: built.length,
    });
}
const runner = fs.readFileSync(
  path.join(
    resources,
    "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
  ),
  "utf8",
);
fs.mkdirSync(path.join(root, ".local"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".local/core-payload-audit.json"),
  JSON.stringify(
    {
      differences,
      runnerHasReplayHook: /installLegacyReplayHook|paseoReplayCompat/.test(
        runner,
      ),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    differences,
    runnerHasReplayHook: /installLegacyReplayHook|paseoReplayCompat/.test(
      runner,
    ),
  }),
);
