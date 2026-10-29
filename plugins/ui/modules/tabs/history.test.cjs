const assert = require("node:assert/strict");
const test = require("node:test");
const { install } = require("./history.js");

function fixture() {
  let entries = [
    { key: "first", serverId: "host", workspaceId: "a", agentId: "one", tabId: "tab-one" },
    { key: "second", serverId: "host", workspaceId: "b", agentId: "two", tabId: "tab-two" },
  ];
  let route = "/h/host/workspace/a";
  const calls = [];
  const state = { layoutByWorkspace: {}, closedTabsByWorkspace: {}, sequence: 0,
    recordClosedTab(key, entry) {
      state.closedTabsByWorkspace[key] = [...(state.closedTabsByWorkspace[key] || []), { ...entry, sequence: ++state.sequence }];
    },
  };
  const model = {
    entries: () => entries,
    close: (key) => { entries = entries.filter((entry) => entry.key !== key); },
    retainAt(serverId, workspaceId, tab, index) { calls.push(["retain", serverId, workspaceId, tab.target.agentId, index]); },
  };
  const original = model.close;
  const history = install({ model, layouts: { getState: () => state }, functions: {},
    reopen({ workspaceKey }) { calls.push(["reopen", workspaceKey]); state.closedTabsByWorkspace[workspaceKey].pop(); },
    navigate: (input) => calls.push(["navigate", input]), pathname: () => route,
    terminal() {}, shortcuts: { getState: () => ({}) },
  });
  return { model, state, calls, history, original, route: (value) => { route = value; } };
}
test("global tab restore retains its original index and workspace outside the current route", () => {
  const f = fixture();
  f.model.close("second");
  assert.equal(f.history.restore(), true);
  assert.deepEqual(f.calls[0], ["retain", "host", "b", "two", 1]);
  assert.deepEqual(f.calls[1], ["reopen", "host:b"]);
  assert.deepEqual(f.calls[2][1].target, { kind: "agent", agentId: "two" });
  assert.equal(f.history.restore(), false);
});
test("a more recently closed native tab keeps the native restore handler first", () => {
  const f = fixture();
  f.model.close("second");
  f.state.closedTabsByWorkspace["host:a"] = [{ sequence: ++f.state.sequence, tab: { target: { kind: "file", path: "a" } } }];
  assert.equal(f.history.restore(), false);
  assert.equal(f.calls.length, 0);
  f.state.closedTabsByWorkspace["host:a"].pop();
  f.route("/settings");
  assert.equal(f.history.restore(), true);
});
test("invalid closes and disposed histories leave the model unchanged", () => {
  const f = fixture();
  f.model.close("missing");
  assert.deepEqual(f.state.closedTabsByWorkspace, {});
  f.history.dispose();
  assert.equal(f.model.close, f.original);
  assert.equal(f.history.restore(), false);
});
test("default reopen ignores IME and repeats and consumes only a successful restore", () => {
  const f = fixture();
  f.model.close("second");
  let prevented = false;
  const event = { code: "KeyT", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false,
    repeat: false, isComposing: true, defaultPrevented: false, preventDefault() { prevented = true; }, stopImmediatePropagation() {} };
  f.history.onKey(event);
  assert.equal(prevented, false);
  event.isComposing = false;
  f.history.onKey(event);
  assert.equal(prevented, true);
});
