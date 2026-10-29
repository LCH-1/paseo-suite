import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packPlugin } from "../plugins/settings-sync/server/files";
import { legacyTransfer } from "../plugins/settings-sync/server/legacy-transfer";
import { normalizeSuitePlugins } from "../plugins/settings-sync/server/suite-compat";
import { nativeStateKey } from "../plugins/settings-sync/server/plugin-state";
import {
  snapshotSchema,
  MAX_BYTES,
  type PluginBackup,
} from "../plugins/settings-sync/shared/model";

const release = path.resolve("dist");
const modules = {
  tabs: true,
  hosts: false,
  import: true,
  titles: false,
  terminal: true,
};
const titles = { version: 1, values: { schemaVersion: 1, enabled: false } };
const unrelated: PluginBackup = {
  id: "unrelated",
  enabled: false,
  files: {},
  settings: {},
};

for (const enabled of [true, false])
  test(`packaged legacy transport preserves disabled modules and UI enabled=${enabled}`, async (context) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-suite-transfer-"));
    context.after(() => rm(home, { recursive: true, force: true }));
    await mkdir(path.join(home, "suite"));
    await writeFile(
      path.join(home, "suite/installed.json"),
      JSON.stringify({ schemaVersion: 1, release }),
    );
    const ui = (await packPlugin(
      home,
      "terminal-tabs",
      path.join(release, "plugins/ui"),
      enabled,
    ))!;
    ui.settings = {
      "paseo-ui": { version: 1, values: { modules } },
      "sidebar-title-sync": titles,
      [nativeStateKey]: { version: 1, values: { enabled: false } },
    };
    const aster = (await packPlugin(
      home,
      "aster",
      path.join(release, "plugins/aster"),
      false,
    ))!;
    aster.settings = {
      example: { version: 1, values: { preserved: "synthetic" } },
    };
    const transfer = await legacyTransfer(home, [ui, aster, unrelated]);
    assert.equal(transfer.length, 8);
    const snapshot = snapshotSchema.parse({
      version: 1,
      createdAt: new Date().toISOString(),
      device: "synthetic",
      client: { hosts: [], preferences: {} },
      config: {},
      plugins: transfer,
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(snapshot)) < MAX_BYTES,
      "old peers must accept the unchanged 5 MiB limit",
    );
    const restored = await normalizeSuitePlugins(home, transfer);
    assert.equal(restored.length, 3);
    const restoredUi = restored.find(
      (plugin) => plugin.id === "terminal-tabs",
    )!;
    assert.equal(restoredUi.enabled, enabled);
    assert.deepEqual(restoredUi.settings["paseo-ui"].values, { modules });
    assert.deepEqual(restoredUi.settings["sidebar-title-sync"], titles);
    assert.deepEqual(restoredUi.settings[nativeStateKey].values, {
      enabled: false,
    });
    assert.deepEqual(
      restored.find((plugin) => plugin.id === "aster")!.settings,
      aster.settings,
    );
    assert.equal(
      restored.find((plugin) => plugin.id === "aster")!.enabled,
      false,
    );
    assert.deepEqual(
      restored.find((plugin) => plugin.id === "aster")!.files,
      aster.files,
    );
    assert.deepEqual(
      restored.find((plugin) => plugin.id === "unrelated"),
      unrelated,
    );
    const peerEdit = transfer.map((plugin) =>
      plugin.id === "host-order" ? { ...plugin, enabled: true } : plugin,
    );
    const changed = (await normalizeSuitePlugins(home, peerEdit)).find(
      (plugin) => plugin.id === "terminal-tabs",
    )!;
    assert.equal(changed.enabled, true);
    assert.equal(
      (changed.settings["paseo-ui"].values as { modules: typeof modules })
        .modules.hosts,
      true,
    );
    const asterOnly = await normalizeSuitePlugins(
      home,
      transfer.filter((plugin) => plugin.id === "aster"),
    );
    assert.deepEqual(asterOnly[0].files, aster.files);
  });

test("ordinary PCs retain their existing snapshot structure", async (context) => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "paseo-ordinary-transfer-"),
  );
  context.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await legacyTransfer(home, [unrelated]), [unrelated]);
  assert.deepEqual(await normalizeSuitePlugins(home, [unrelated]), [unrelated]);
});
