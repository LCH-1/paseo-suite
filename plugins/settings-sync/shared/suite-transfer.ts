import { z } from "zod";
export const uiTransferKey = "paseo-suite.ui-transfer.v1";
export const uiIds = { tabs: "global-workspace-tabs", hosts: "host-order", import: "session-import", titles: "sidebar-title-sync", terminal: "terminal-tabs" } as const;
export const uiModulesSchema = z.object({ tabs: z.boolean(), hosts: z.boolean(), import: z.boolean(), titles: z.boolean(), terminal: z.boolean() });
export const uiTransferSchema = z.object({ enabled: z.boolean(), modules: uiModulesSchema, projection: uiModulesSchema });
