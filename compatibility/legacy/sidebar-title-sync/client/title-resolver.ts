import type { AgentTabTitle, AgentTabTitleContext } from "./sdk-extension";

export function resolveSidebarTitle(context: AgentTabTitleContext, cachedProjectName: string | null = null): AgentTabTitle | null {
  if (!context.serverId || !context.workspaceId || !context.agentId) return null;
  if (typeof context.sidebarLabel !== "string" || context.sidebarLabel.length === 0) return null;
  const projectName = context.projectLabel ?? cachedProjectName;
  if (projectName === null || projectName.length === 0) return context.sidebarLabel;
  return "projectLabel" in context
    ? { primaryLabel: projectName, secondaryLabel: context.sidebarLabel }
    : `${projectName}-${context.sidebarLabel}`;
}
