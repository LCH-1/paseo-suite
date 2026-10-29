import assert from "node:assert/strict";
import { test } from "node:test";
import { UiModules } from "../plugins/ui/client/modules";
import { moduleIds } from "../plugins/ui/shared/settings";

test("UI modules preserve disabled features and release each registration once", async () => {
  const active = new Set<string>();
  const starts = Object.fromEntries(
    moduleIds.map((id) => [
      id,
      () => {
        assert.equal(active.has(id), false);
        active.add(id);
        return () => {
          assert.equal(active.delete(id), true);
        };
      },
    ]),
  ) as ConstructorParameters<typeof UiModules>[0];
  const modules = new UiModules(starts);
  const flags = {
    tabs: true,
    hosts: false,
    import: true,
    titles: false,
    terminal: true,
  };
  modules.apply({ modules: flags });
  modules.apply({ modules: flags });
  assert.deepEqual([...active], ["tabs", "import", "terminal"]);
  modules.apply({ modules: { ...flags, tabs: false, titles: true } });
  assert.deepEqual([...active], ["import", "terminal", "titles"]);
  await modules.dispose();
  await modules.dispose();
  modules.apply({ modules: flags });
  assert.equal(active.size, 0);
});

test("a failing new UI module restores registrations it acquired during that change", () => {
  const active = new Set<string>();
  const starts = Object.fromEntries(
    moduleIds.map((id) => [
      id,
      () => {
        if (id === "import") throw Error("unsupported host");
        active.add(id);
        return () => {
          active.delete(id);
        };
      },
    ]),
  ) as ConstructorParameters<typeof UiModules>[0];
  const modules = new UiModules(starts);
  assert.throws(
    () =>
      modules.apply({
        modules: {
          tabs: true,
          hosts: true,
          import: true,
          titles: true,
          terminal: true,
        },
      }),
    /unsupported host/,
  );
  assert.equal(active.size, 0);
});
