import assert from "node:assert/strict";
import { test } from "node:test";
import { startUsagePolling } from "../plugins/ui/client/usage-polling";

test("old Core usage refreshes on its timer, skips inactive/native/offline queries and disposes", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new EventTarget(),
  });
  t.after(() => {
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const query = (host: string, active = true, interval?: number) => ({
    queryKey: ["usage", host, "reports"],
    options: { refetchInterval: interval },
    isActive: () => active,
  });
  const queries = [
    query("old"),
    query("native", true, 60_000),
    query("closed", false),
    query("offline"),
  ];
  let visible = true;
  let runs = 0;
  let pending: (() => void) | undefined;
  const dispose = startUsagePolling(
    {
      getQueryCache: () => ({ getAll: () => queries }),
      refetchQueries: (filters, options) => {
        runs++;
        assert.equal(options.cancelRefetch, false);
        assert.deepEqual(
          queries.filter(filters.predicate).map((q) => q.queryKey[1]),
          ["old"],
        );
        return new Promise<void>((resolve) => {
          pending = resolve;
        });
      },
    },
    (host) => host !== "offline",
    () => visible,
  );
  t.after(dispose);
  t.mock.timers.tick(59_999);
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  assert.equal(runs, 1);
  t.mock.timers.tick(60_000);
  assert.equal(
    runs,
    1,
    "a slow source must not accumulate overlapping requests",
  );
  pending!();
  await new Promise((resolve) => setImmediate(resolve));
  visible = false;
  t.mock.timers.tick(60_000);
  assert.equal(runs, 1);
  visible = true;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(runs, 2);
  pending!();
  await new Promise((resolve) => setImmediate(resolve));
  dispose();
  t.mock.timers.tick(60_000);
  window.dispatchEvent(new Event("focus"));
  assert.equal(runs, 2);
});
