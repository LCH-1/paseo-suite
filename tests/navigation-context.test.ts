import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import { act, create } from "react-test-renderer";
import {
  assertNavigationContext,
  repairNavigationContext,
} from "../tools/navigation-context.mjs";

function fixture() {
  const core = (id: number) =>
    `__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"BaseNavigationContainer",{value:null});Object.defineProperty(e,"NavigationContext",{enumerable:true,value:r(d[0]).createContext(undefined)});Object.defineProperty(e,"useNavigation",{enumerable:true,value:function(){const navigation=r(d[0]).useContext(e.NavigationContext);if(!navigation)throw Error("Couldn't find a navigation object. Is your component inside NavigationContainer?");return navigation}})},${id},[1]);`;
  const native = (id: number, coreId: number) =>
    `__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"NavigationContainer",{value:null});Object.defineProperty(e,"createStaticNavigation",{value:null});Object.defineProperty(e,"LocaleDirContext",{value:null});m.exports=Object.assign(e,r(d[0]))},${id},[${coreId}]);`;
  return [
    core(2),
    native(3, 2),
    core(4),
    native(5, 4),
    '__d(function(g,r,i,a,m,e,d){e.useNavigation=function(){return r(d[0]).useNavigation()};e.message="Invalid parent path"},6,[3]);',
  ].join("\n");
}

function load(source: string) {
  const factories = new Map();
  const cache = new Map([[1, React]]);
  runInNewContext(source, {
    __d: (factory: unknown, id: number, dependencies: number[]) =>
      factories.set(id, { factory, dependencies }),
  });
  function requireModule(id: number): Record<string, unknown> {
    if (cache.has(id)) return cache.get(id);
    const { factory, dependencies } = factories.get(id);
    const module = { exports: {} };
    cache.set(id, module.exports);
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
  }
  return requireModule;
}

test("repair joins transplanted navigation hooks to the router provider", async () => {
  const source = fixture();
  assert.throws(
    () => assertNavigationContext(source),
    /Duplicate React Navigation contexts/,
  );
  const original = load(source);
  assert.notEqual(original(3).NavigationContext, original(5).NavigationContext);
  const repaired = repairNavigationContext(source);
  assert.deepEqual(repaired.aliases, [
    { from: 5, to: 3 },
    { from: 4, to: 2 },
  ]);
  const requireModule = load(repaired.source);
  assert.equal(requireModule(3), requireModule(5));
  assert.equal(requireModule(2), requireModule(4));
  const context = requireModule(3).NavigationContext as React.Context<{
    setParams: () => void;
  }>;
  const useNavigation = requireModule(5).useNavigation as () => {
    setParams: () => void;
  };
  const navigation = { setParams() {} };
  let received;
  function WorkspaceRoute() {
    received = useNavigation();
    return React.createElement("workspace");
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      React.createElement(
        context.Provider,
        { value: navigation },
        React.createElement(WorkspaceRoute),
      ),
    );
  });
  assert.equal(received, navigation);
  await act(async () => renderer.unmount());
  assertNavigationContext(repaired.source);
  assert.deepEqual(repairNavigationContext(repaired.source).aliases, []);
});

test("repair refuses an ambiguous router or incompatible exports", () => {
  assert.throws(
    () =>
      repairNavigationContext(
        fixture().replace("Invalid parent path", "unknown"),
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      repairNavigationContext(
        fixture().replace(
          "},5,[4]);",
          ';Object.defineProperty(e,"extra",{value:1})},5,[4]);',
        ),
      ),
    /contracts differ/,
  );
  assert.throws(
    () => assertNavigationContext("unknown bundle"),
    /not identified/,
  );
});
