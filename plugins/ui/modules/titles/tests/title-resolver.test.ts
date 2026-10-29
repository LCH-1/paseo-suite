import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTabTitleContext } from "../client/sdk-extension";
import { resolveSidebarTitle } from "../client/title-resolver";

const context: AgentTabTitleContext = {
  serverId: "host-1", workspaceId: "workspace-1", agentId: "agent-1",
  defaultLabel: "주문 API 수정해줘", sidebarLabel: "  결제 기능 개선 🧾 / 브랜치  ",
};

test("preserves the exact raw Korean, emoji and whitespace label without changing stored context", () => {
  const frozen = Object.freeze({ ...context });
  assert.equal(resolveSidebarTitle(frozen), context.sidebarLabel);
  assert.equal(frozen.defaultLabel, "주문 API 수정해줘");
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: "첨부 이미지 📷" }), "첨부 이미지 📷");
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: " " }), " ");
});

test("delegates missing workspace labels or incomplete ownership to the default title", () => {
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: null }), null);
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: "" }), null);
  assert.equal(resolveSidebarTitle({ ...context, serverId: "" }), null);
  assert.equal(resolveSidebarTitle({ ...context, workspaceId: "" }), null);
  assert.equal(resolveSidebarTitle({ ...context, agentId: "" }), null);
});

test("uses each tab's supplied sidebar label independently of host, workspace or agent ID collisions", () => {
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: "첫 호스트" }), "첫 호스트");
  assert.equal(resolveSidebarTitle({ ...context, serverId: "host-2", sidebarLabel: "둘째 호스트" }), "둘째 호스트");
  assert.equal(resolveSidebarTitle({ ...context, workspaceId: "workspace-2", sidebarLabel: "동일 경로의 다른 작업공간" }), "동일 경로의 다른 작업공간");
});

test("prefixes the official project name using one hyphen and the supplied sidebar label", () => {
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: "main" }, "cursor-setting-sync"), "cursor-setting-sync-main");
  assert.equal(resolveSidebarTitle(context, "프로젝트 🧩"), `프로젝트 🧩-${context.sidebarLabel}`);
  assert.equal(resolveSidebarTitle({ ...context, sidebarLabel: null }, "project"), null);
  assert.equal(resolveSidebarTitle(context, ""), context.sidebarLabel);
  assert.equal(resolveSidebarTitle(context, null), context.sidebarLabel);
  assert.equal(context.defaultLabel, "주문 API 수정해줘");
});

test("modern contexts use app-provided project metadata and preserve project/workspace boundaries", () => {
  const modern = Object.freeze({ ...context, projectLabel: "project-with-hyphens" });
  assert.deepEqual(resolveSidebarTitle(modern, "outdated-cache"), {
    primaryLabel: "project-with-hyphens", secondaryLabel: context.sidebarLabel,
  });
  assert.deepEqual(resolveSidebarTitle({ ...modern, projectLabel: null }, "cached-project"), {
    primaryLabel: "cached-project", secondaryLabel: context.sidebarLabel,
  });
  assert.equal(resolveSidebarTitle({ ...modern, projectLabel: null }), context.sidebarLabel);
  assert.equal(resolveSidebarTitle({ ...modern, sidebarLabel: null }), null);
  assert.equal(modern.defaultLabel, "주문 API 수정해줘");
});
