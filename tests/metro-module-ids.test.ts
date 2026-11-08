import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  allocateMetroModuleId,
  readMetroModules,
} from "../tools/metro-module-ids.mjs";

test("injected helper does not shadow a lazy attachment store", () => {
  const source = [
    '__d(function(g,r,i,a,m,e,d){e.getStore=()=>r(d[0]).createDesktopAttachmentStore()},2,{"0":5,"paths":{"5":"/store.js","6":"/bridge.js"}});',
    "__d(function(g,r,i,a,m,e,d){e.sideBar=true},4,[]);",
  ].join("\n");
  const helperId = allocateMetroModuleId(source);
  assert.equal(helperId, 7);
  assert.equal(readMetroModules(source)[0].id, 2);
  const factories = new Map();
  const requireModule = (id: number): any => {
    if (!factories.has(id)) {
      assert.equal(id, 5);
      runInNewContext(
        '__d(function(g,r,i,a,m,e,d){e.createDesktopAttachmentStore=()=>"saved"},5,[]);',
        context,
      );
    }
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
    return module.exports;
  };
  const context = {
    __d: (factory: unknown, id: number, dependencies: unknown) => {
      // Metro keeps the first registration, which made the collision persistent.
      if (!factories.has(id)) factories.set(id, { factory, dependencies });
    },
  };
  runInNewContext(
    `${source}\n__d(function(g,r,i,a,m,e,d){e.icon=true},${helperId},[]);`,
    context,
  );
  assert.equal(requireModule(2).getStore(), "saved");
  assert.equal(requireModule(helperId).icon, true);
});

test("reserves unregistered synchronous dependencies and CRLF registrations", () => {
  assert.equal(allocateMetroModuleId("__d(function(){},3,[1,19]);\r\n"), 20);
});

test("refuses an unrecognized bundle or invalid dependency IDs", () => {
  assert.throws(() => allocateMetroModuleId("__r(0);"), /not found/);
  assert.throws(
    () => allocateMetroModuleId('__d(function(){},1,{"0":-1});'),
    /Invalid/,
  );
});
