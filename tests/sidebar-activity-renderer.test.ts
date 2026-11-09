import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import { act, create } from "react-test-renderer";
import * as jsx from "react/jsx-runtime";
import { repairSidebarActivityView } from "../tools/sidebar-activity-renderer.mjs";

function fixture(viewAlias = "v", textAlias = "n") {
  return [
    '__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"View",{value:"section"})},1,[]);',
    '__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"Text",{value:"span"})},2,[]);',
    `__d(function(g,r,i,a,m,e,d){var ${viewAlias}=r(d[0]),${textAlias}=r(d[1]),j=r(d[2]),p=r(d[3]);const s={tabNameRow:{}};e.SidebarActivityPanel=function({view}){return j.jsxs(${textAlias}.View,{style:s.tabNameRow,children:[j.jsx(p.SidebarProviderIcon,{provider:view==="running"?"codex":"claude"}),j.jsx(${textAlias}.Text,{children:view})]})}},9,[1,2,3,4]);`,
  ].join("\n");
}

function load(source: string) {
  const factories = new Map();
  const cache = new Map<number, any>([
    [3, jsx],
    [
      4,
      {
        SidebarProviderIcon: ({ provider }: { provider: string }) =>
          React.createElement("i", { "data-provider": provider }),
      },
    ],
  ]);
  const requireModule = (id: number): any => {
    if (cache.has(id)) return cache.get(id);
    const { factory, dependencies } = factories.get(id);
    const module = { exports: {} };
    factory(
      {},
      requireModule,
      null,
      null,
      module,
      module.exports,
      dependencies,
    );
    cache.set(id, module.exports);
    return module.exports;
  };
  runInNewContext(source, {
    __d: (factory: unknown, id: number, dependencies: unknown) =>
      factories.set(id, { factory, dependencies }),
  });
  return requireModule(9).SidebarActivityPanel;
}

test("rejects the broken component in both activity filters and repairs the import", () => {
  for (const view of ["running", "unreviewed"]) {
    const broken = load(fixture());
    assert.equal(broken({ view }).type, undefined);
    const repaired = repairSidebarActivityView(fixture());
    const element = load(repaired.source)({ view });
    assert.equal(element.type, "section");
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(element);
    });
    assert.ok(renderer?.toJSON());
    act(() => {
      renderer?.unmount();
    });
    assert.equal(repaired.panelId, 9);
    assert.equal(repaired.viewModuleId, 1);
  }
});

test("resolves minified import names and preserves all other module registrations", () => {
  const before = fixture("$view", "text");
  const repaired = repairSidebarActivityView(before);
  assert.equal(repaired.source.split("\n")[0], before.split("\n")[0]);
  assert.equal(repaired.source.split("\n")[1], before.split("\n")[1]);
  assert.equal(repaired.source, before.replace("text.View,", "$view.View,"));
  assert.equal(repairSidebarActivityView(repaired.source).changed, false);
});

test("refuses an unknown component owner or ambiguous activity modules", () => {
  assert.throws(
    () =>
      repairSidebarActivityView(fixture().replace("n.View,", "unknown.View,")),
    /Unexpected/,
  );
  assert.throws(
    () => repairSidebarActivityView(fixture() + "\n" + fixture()),
    /ambiguous/,
  );
});
