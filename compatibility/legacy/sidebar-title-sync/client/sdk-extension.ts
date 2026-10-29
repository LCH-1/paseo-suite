import type { PluginClientContext } from "@getpaseo/plugin/client";

// This optional contract is proposed in host/paseo; 0.12.0 does not provide it.
export interface AgentTabTitleContext {
  readonly serverId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly subagentId?: string;
  readonly defaultLabel: string;
  readonly sidebarLabel: string | null;
  readonly projectLabel?: string | null;
}

export type AgentTabTitle = string | { readonly primaryLabel: string; readonly secondaryLabel: string };

export interface AgentTabTitleRegistration {
  invalidate(): void;
  remove(): void;
}

export interface AgentTabTitleCapability {
  addAgentTabTitleResolver(contribution: {
    id: string;
    resolve(context: AgentTabTitleContext): AgentTabTitle | null;
  }): AgentTabTitleRegistration;
}

export type TitleSyncClient = Pick<PluginClientContext, "rpc" | "paseo"> & Partial<AgentTabTitleCapability>;
