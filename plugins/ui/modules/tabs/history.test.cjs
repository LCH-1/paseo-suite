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
    takeLastClosedTab(key) { return state.closedTabsByWorkspace[key]?.pop() ?? null; },
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

test("보관된 대화의 닫은 탭 복원은 레이아웃 재열기와 화면 이동을 실행하지 않는다",()=>{
  const f=fixture();
  f.model.close("second");
  f.model.retainAt=()=>null;
  assert.equal(f.history.restore(),false);
  assert.deepEqual(f.calls,[]);
});

test("보관된 대화의 닫은 기록을 건너뛰고 직전의 일반 대화를 복원한다",()=>{
  const f=fixture(), retain=f.model.retainAt;
  f.model.close("first"); f.model.close("second");
  f.model.retainAt=(serverId,workspaceId,tab,index)=>tab.target.agentId==="two"?null:retain(serverId,workspaceId,tab,index);
  assert.equal(f.history.restore(),true);
  assert.deepEqual(f.calls.map(call=>call[0]),["retain","reopen","navigate"]);
  assert.equal(f.calls[0][3],"one");
  assert.equal(f.state.closedTabsByWorkspace["host:b"].length,0);
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
