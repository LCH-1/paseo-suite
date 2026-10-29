import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeSuitePlugins } from "../server/suite-compat";
import { nativeStateKey, preparePluginState } from "../server/plugin-state";
import type { PluginBackup } from "../shared/model";

test("an old eight-plugin snapshot restores as Suite roles with the same enabled features and native usage flag", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-suite-snapshot-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const release = path.join(home, "release");
  await mkdir(path.join(home, "suite"));
  await writeFile(path.join(home, "suite/installed.json"), JSON.stringify({ schemaVersion: 1, release, nativeUsagePending: true }));
  for (const [name, id] of [["ui", "terminal-tabs"], ["aster", "aster"]]) {
    const directory = path.join(release, "plugins", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }));
    await writeFile(path.join(directory, "index.client.ts"), "export default () => () => {};");
  }
  const old = (id: string, enabled = true): PluginBackup => ({ id, enabled, files: {}, settings: {} });
  const titles = { version: 1, values: { schemaVersion: 1, enabled: false } };
  const incoming = [old("global-workspace-tabs"), old("host-order", false), old("session-import"),
    { ...old("sidebar-title-sync"), settings: { "sidebar-title-sync": titles } }, old("terminal-tabs", false),
    { ...old("aster"), files: { "server/credential-sharing.ts": Buffer.from("old relay").toString("base64") } },
    old("claude-windows-usage", false), old("unrelated"),
  ];
  const original = structuredClone(incoming);
  const result = await normalizeSuitePlugins(home, incoming);
  assert.deepEqual(incoming, original);
  assert.deepEqual(result.map((plugin) => plugin.id).sort(), ["aster", "terminal-tabs", "unrelated"]);
  const ui = result.find((plugin) => plugin.id === "terminal-tabs")!;
  assert.deepEqual(ui.settings["paseo-ui"].values, { modules: { tabs: true, hosts: false, import: true, titles: true, terminal: false } });
  assert.deepEqual(ui.settings["sidebar-title-sync"], titles);
  assert.deepEqual(ui.settings[nativeStateKey].values, { enabled: false });
  assert.deepEqual(JSON.parse((await preparePluginState(home, ui))!.raw), { version: 1, values: { enabled: false } });
  assert.equal(result.find((plugin) => plugin.id === "aster")!.files["server/credential-sharing.ts"], undefined);
});
