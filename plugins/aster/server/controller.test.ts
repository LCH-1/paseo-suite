import assert from "node:assert/strict";
import test from "node:test";
import { Controller } from "./controller";

test("시작 가능 여부 확인은 부트스트랩 순환을 진행하지 않는다", () => {
  const controller = new Controller();
  const now = 1800000000000;
  assert.equal(controller.canBootstrap([], now), false);
  assert.equal(controller.canBootstrap(["a", "b"], now), true);
  const first = controller.bootstrap("agent", ["a", "b"], now);
  controller.canBootstrap(["a", "b"], now);
  assert.notEqual(controller.bootstrap("agent", ["a", "b"], now), first);
  controller.limitAccount("a", now);
  controller.limitAccount("b", now);
  assert.equal(controller.canBootstrap(["a", "b"], now), false);
});
