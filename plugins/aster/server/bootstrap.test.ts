import assert from "node:assert/strict";
import test from "node:test";
import { Controller } from "./controller.ts";

test("만료 초기화 계정은 현재 부하와 순서로 분배하며 인증실패 계정은 건너뛴다", () => {
  const controller = new Controller();
  assert.equal(controller.bootstrap("first", ["a", "b"], 100), "a");
  controller.bind("first", "a", 100);
  assert.equal(controller.bootstrap("second", ["a", "b"], 100), "b");
  controller.bind("second", "b", 100);
  controller.limited("second", 100);
  assert.equal(controller.bootstrap("third", ["a", "b"], 100), "a");
  assert.equal(controller.bootstrap("third", ["b"], 100), null);
  assert.equal(controller.bootstrap("third", ["b"], 60_101), "b");
  assert.equal(controller.bootstrap("third", [], 60_101), null);
});
