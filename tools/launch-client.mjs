import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
const root = path.resolve(import.meta.dirname, "..");
const program = path.resolve(process.argv[2]);
const metadataPath = path.resolve(process.argv[3]);
const require = createRequire(path.join(root, "../paseo-core/package.json"));
const { chromium } = require("playwright");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const env = { ...process.env };
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "PASEO_DESKTOP_CLI",
  "PASEO_ELECTRON_USER_DATA_DIR",
  "PASEO_TEST_APP_NAME",
  "PASEO_DISABLE_SINGLE_INSTANCE_LOCK",
  "PASEO_AGENT_ID",
  "PASEO_WORKSPACE_ID",
  "PASEO_HOST",
  "EXPO_DEV_URL",
])
  delete env[key];
env.PASEO_ELECTRON_FLAGS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
const child = spawn(program, [], {
  env,
  cwd: path.dirname(program),
  detached: true,
  windowsHide: true,
  stdio: "ignore",
});
await once(child, "spawn");
if (env.PASEO_CLIENT_SWITCH_JOURNAL)
  await fs.appendFile(
    env.PASEO_CLIENT_SWITCH_JOURNAL,
    JSON.stringify({ pid: child.pid, program }) + "\n",
  );
child.unref();
await fs.writeFile(
  metadataPath,
  JSON.stringify(
    { pid: child.pid, port, program, profile: path.join(env.APPDATA, "Paseo") },
    null,
    2,
  ),
);
let browser;
try {
  const deadline = Date.now() + 120000;
  let page;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw Error(`Paseo exited during startup: ${child.exitCode}`);
    if (!browser)
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })
        .catch(() => null);
    page = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith("paseo://app"));
    if (page) break;
    await delay(200);
  }
  if (!page) throw Error("Paseo initialization did not create its app window");
  await page.waitForFunction(
    () => Boolean(globalThis.__PASEO_GLOBAL_TABS__),
    undefined,
    { timeout: 90000 },
  );
  console.log(JSON.stringify({ pid: child.pid, ready: true }));
} finally {
  await browser?.close();
}
