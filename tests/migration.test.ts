import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planMigration,
  transitionPlugins,
  type PluginSource,
} from "../tools/migration";

const entry = (name: string, enabled = true): PluginSource => ({
  source: "directory",
  path: `/plugins/${name}`,
  enabled,
});
test("migration preserves config, disabled modules and the original caller object", () => {
  const config = {
    pluginsEnabled: false,
    providers: { kept: { env: { EXAMPLE: "synthetic" } } },
    unknown: { retained: true },
    plugins: {
      "terminal-tabs": entry("terminal", false),
      "global-workspace-tabs": entry("global"),
      "host-order": entry("hosts", false),
      aster: entry("aster"),
      "claude-windows-usage": entry("windows"),
      other: entry("other"),
    },
  };
  const previous = structuredClone(config);
  const result = planMigration(config, "/release", { nativeUsage: true });
  assert.deepEqual(config, previous);
  assert.equal(result.config.pluginsEnabled, false);
  assert.deepEqual(result.config.providers, config.providers);
  assert.deepEqual(result.config.unknown, config.unknown);
  assert.deepEqual(result.config.plugins?.other, config.plugins.other);
  assert.deepEqual(result.ui.modules, {
    tabs: true,
    hosts: false,
    import: false,
    titles: false,
    terminal: false,
  });
  assert.deepEqual(result.sync, { backup: false, relay: true });
  assert.equal(result.config.plugins?.["settings-sync"].enabled, true);
  assert.equal(result.config.plugins?.["claude-windows-usage"], undefined);
});

test("a failed install rolls back just its own plugin changes", async () => {
  const original = { old: entry("old"), untouched: entry("untouched", false) };
  let state = structuredClone(original);
  let failed = false;
  await assert.rejects(
    transitionPlugins(
      {
        list: async () => structuredClone(state),
        remove: async (id) => {
          delete state[id as keyof typeof state];
        },
        install: async (id, source) => {
          if (id === "replacement" && !failed) {
            failed = true;
            throw Error("compile failed");
          }
          state = { ...state, [id]: source };
        },
      },
      { replacement: entry("new"), untouched: original.untouched },
    ),
    /compile failed/,
  );
  assert.deepEqual(state, original);
});

test("rollback refuses to overwrite a concurrent plugin update", async () => {
  let state: Record<string, PluginSource> = { ui: entry("old") };
  await assert.rejects(
    transitionPlugins(
      {
        list: async () => structuredClone(state),
        remove: async (id) => {
          delete state[id];
        },
        install: async () => {
          state.ui = entry("concurrent");
          throw Error("interrupted");
        },
      },
      { ui: entry("new") },
    ),
    /need recovery/,
  );
  assert.equal(state.ui.path, "/plugins/concurrent");
});

test("a plugin added by another session after planning is left unchanged", async () => {
  const baseline = { ui: entry("old") };
  const concurrent = entry("concurrent");
  let state: Record<string, PluginSource> = {
    ...baseline,
    unrelated: concurrent,
  };
  await transitionPlugins(
    {
      list: async () => structuredClone(state),
      remove: async (id) => {
        delete state[id];
      },
      install: async (id, value) => {
        state[id] = value;
      },
    },
    { ui: entry("new") },
    baseline,
  );
  assert.deepEqual(state.unrelated, concurrent);
});
