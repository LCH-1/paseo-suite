import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { prepare } from "../tools/bootstrap";

test("offline setup preserves every non-plugin config value, title settings and idempotent module edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-suite-offline-"));
  const home = path.join(root, "home");
  const resourcesPath = path.join(root, "resources");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(resourcesPath, "suite"), { recursive: true });
  const lock = {
    schemaVersion: 1,
    plugins: ["ui", "aster", "settings-sync"].map((name) => ({
      name,
      id: name,
      files: [],
    })),
  };
  const treeHash = createHash("sha256")
    .update(JSON.stringify(lock))
    .digest("hex");
  await fs.writeFile(
    path.join(resourcesPath, "suite/suite-lock.json"),
    JSON.stringify({ ...lock, treeHash }),
  );
  const original = {
    pluginsEnabled: false,
    providers: { example: { enabled: false } },
    plugins: {
      "sidebar-title-sync": {
        source: "directory",
        path: "/original/titles",
        enabled: false,
      },
      "terminal-tabs": {
        source: "directory",
        path: "/original/terminal",
        enabled: true,
      },
    },
    custom: { preserved: [1, 2, 3] },
  };
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify(original));
  const oldTitle = path.join(
    home,
    "plugin-settings/sidebar-title-sync/sidebar-title-sync.json",
  );
  await fs.mkdir(path.dirname(oldTitle), { recursive: true });
  const rawTitle =
    '{"version":1,"values":{"schemaVersion":1,"enabled":false}}\n';
  await fs.writeFile(oldTitle, rawTitle);
  const context = {
    home,
    resourcesPath,
    executable: "unused",
    isDaemonRunning: async () => false,
  };
  try {
    await prepare(context);
    const current = JSON.parse(
      await fs.readFile(path.join(home, "config.json"), "utf8"),
    );
    assert.equal(current.pluginsEnabled, false);
    assert.deepEqual(current.providers, original.providers);
    assert.deepEqual(current.custom, original.custom);
    assert.equal(
      await fs.readFile(
        path.join(
          home,
          "plugin-settings/terminal-tabs/sidebar-title-sync.json",
        ),
        "utf8",
      ),
      rawTitle,
    );
    assert.equal(await fs.readFile(oldTitle, "utf8"), rawTitle);
    const settings = path.join(
      home,
      "plugin-settings/terminal-tabs/paseo-ui.json",
    );
    const edited = '{"version":1,"values":{"modules":{"terminal":false}}}';
    await fs.writeFile(settings, edited);
    await prepare(context);
    assert.equal(await fs.readFile(settings, "utf8"), edited);
    const flag = JSON.parse(
      await fs.readFile(
        path.join(home, "plugin-settings/claude-windows-usage/native.json"),
        "utf8",
      ),
    );
    assert.equal(flag.values.enabled, false);
    current.plugins["terminal-tabs"].enabled = false;
    current.plugins.aster.enabled = true;
    current.plugins["settings-sync"].enabled = false;
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify(current));
    const nextLock = { ...lock, release: "next" };
    await fs.writeFile(
      path.join(resourcesPath, "suite/suite-lock.json"),
      JSON.stringify({
        ...nextLock,
        treeHash: createHash("sha256")
          .update(JSON.stringify(nextLock))
          .digest("hex"),
      }),
    );
    await prepare(context);
    const upgraded = JSON.parse(
      await fs.readFile(path.join(home, "config.json"), "utf8"),
    );
    assert.equal(upgraded.plugins["terminal-tabs"].enabled, false);
    assert.equal(upgraded.plugins.aster.enabled, true);
    assert.equal(upgraded.plugins["settings-sync"].enabled, false);
    assert.equal(await fs.readFile(settings, "utf8"), edited);
    assert.deepEqual(upgraded.custom, original.custom);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
